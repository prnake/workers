import { AwsClient } from "aws4fetch";

const MODEL_MAPPING = {
	"claude-instant-1.2":         "anthropic.claude-instant-v1",
	"claude-2.0":                 "anthropic.claude-v2",
	"claude-2.1":                 "anthropic.claude-v2:1",
	"claude-3-sonnet-20240229":   "anthropic.claude-3-sonnet-20240229-v1:0",
	"claude-3-opus-20240229":     "anthropic.claude-3-opus-20240229-v1:0",
	"claude-3-haiku-20240307":    "anthropic.claude-3-haiku-20240307-v1:0",
	"claude-3-5-sonnet-20240620": "anthropic.claude-3-5-sonnet-20240620-v1:0",
	"claude-3-5-sonnet-20241022": "anthropic.claude-3-5-sonnet-20241022-v2:0",
	"claude-3-5-haiku-20241022":  "anthropic.claude-3-5-haiku-20241022-v1:0",
	"claude-3-7-sonnet-20250219": "anthropic.claude-3-7-sonnet-20250219-v1:0",
	"claude-sonnet-4-20250514":   "anthropic.claude-sonnet-4-20250514-v1:0",
	"claude-opus-4-20250514":     "anthropic.claude-opus-4-20250514-v1:0",
  "claude-opus-4-1-20250805":   "anthropic.claude-opus-4-1-20250805-v1:0",
};

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

const explainAuthKey = (authKey) => {
  const region = authKey.match(/region=([^;]*)/)?.[1] || null;
  const accessKeyId = authKey.match(/accessKeyId=([^;]*)/)?.[1] || null;
  const secretAccessKey = authKey.match(/secretAccessKey=([^;]*)/)?.[1] || null;
  return { region, accessKeyId, secretAccessKey };
};

const handleRequest = async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  let body;
  if (request.method === "POST") body = await request.json();

  let { model } = body || {};
  if (model && model.includes(':')) {
    model = model.split(':')[1];
  }

  let deployName = MODEL_MAPPING[model] || "";
  if (deployName === "") return new Response("Not allowed", { status: 403 });

  const { region, accessKeyId, secretAccessKey } = explainAuthKey(request.headers.get("Authorization"));
  if (!region || !accessKeyId || !secretAccessKey) return new Response("Not allowed", { status: 403 });

  if(region.startsWith("us-")) {
    deployName = "us." + deployName;
  } else {
    deployName = "apac." + deployName;
  }

  const isStreaming = body.stream === true;
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "bedrock" });
  const fetchAPI = isStreaming ? `https://bedrock-runtime.${region}.amazonaws.com/model/${deployName}/invoke-with-response-stream` : `https://bedrock-runtime.${region}.amazonaws.com/model/${deployName}/invoke`;
  
  delete body["model"];
  delete body["n"];
  delete body["stream"];
  delete body["stream_options"];
  

  const requestPayload = {
    anthropic_version: "bedrock-2023-05-31",
    ...body,
  };

  // return new Response(JSON.stringify(requestPayload), {
  //   headers: {
  //     "Content-Type": "application/json",
  //   },
  // });

  let response = await aws.fetch(fetchAPI, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      // ...(isStreaming && { "Accept": "text/event-stream" })
    },
    body: JSON.stringify(requestPayload),
  });

  // Handle streaming response
  if (isStreaming) {
    const { readable, writable } = new TransformStream();
    response.body.pipeTo(writable);
    
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // Handle regular response
  response = new Response(response.body, response);
  response.headers.set("Access-Control-Allow-Origin", "*");
  const responseData = await response.json();
  
  if (responseData.usage) {
    responseData.usage = {
      ...responseData.usage,
      prompt_tokens: responseData.usage.input_tokens,
      completion_tokens: responseData.usage.output_tokens,
      total_tokens: responseData.usage.input_tokens + responseData.usage.output_tokens
    };
  }

  response = new Response(JSON.stringify(responseData), {
    headers: response.headers
  });
  return response;
};
