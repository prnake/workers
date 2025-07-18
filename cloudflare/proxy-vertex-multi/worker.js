const MODELS = {
    "vertex:claude-sonnet-4-20250514": {
        vertexName: "claude-sonnet-4@20250514",
        region: "us-east5",
    },
    "vertex:claude-3-7-sonnet-20250219": {
        vertexName: "claude-3-7-sonnet@20250219",
        region: "us-east5",
    }
};

addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    let headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    if (request.method === "OPTIONS") {
        return new Response(null, { headers });
    } else if (request.method === "GET") {
        return createErrorResponse(405, "invalid_request_error", "GET method is not allowed");
    }

    const apiKey_and_settings = request.headers.get("x-api-key") || request.headers.get("Authorization").split(" ")[1];
    // 解析 apiKey_and_settings 字符串，提取 key 和 region
    let apiKey = "";
    let apiRegion = "";
    let apiGCPKey = "A";
    
    if (apiKey_and_settings && apiKey_and_settings.includes(';')) {
        const parts = apiKey_and_settings.split(';');
        for (const part of parts) {
            const [key, value] = part.split('=');
            if (key === 'key') {
                apiKey = value;
            } else if (key === 'region') {
                apiRegion = value;
            } else if (key === 'gcp_key') {
                apiGCPKey = value;
            }
        }
    } else {
        // 如果没有分号，则整个字符串作为 apiKey
        apiKey = apiKey_and_settings;
    }

    if (!API_KEY || API_KEY !== apiKey) {
        return createErrorResponse(401, "authentication_error", "invalid x-api-key");
    }

    let gcpCredentials = {};
    const gcpKeyVar = `GCP_KEY_${apiGCPKey}`;
    if (typeof globalThis[gcpKeyVar] !== 'undefined') {
        gcpCredentials = JSON.parse(globalThis[gcpKeyVar]);
    } else {
        return createErrorResponse(401, "authentication_error", "invalid apiGCPKey");
    }
    const CLIENT_EMAIL = gcpCredentials.client_email;
    const PRIVATE_KEY = gcpCredentials.private_key;
    const PROJECT = gcpCredentials.project_id;

    const signedJWT = await createSignedJWT(CLIENT_EMAIL, PRIVATE_KEY)
    const [token, err] = await exchangeJwtForAccessToken(signedJWT)
    if (token === null) {
        console.log(`Invalid jwt token: ${err}`)
        return createErrorResponse(500, "api_error", "invalid authentication credentials");
    }

    try {
        const url = new URL(request.url);
        const normalizedPathname = url.pathname.replace(/^(\/)+/, '/');
        switch(normalizedPathname) {
            case "/v1/v1/messages":
            case "/v1/messages":
            case "/v1/chat/completions":
            case "/messages":
            default:
                return handleMessagesEndpoint(request, token, PROJECT, apiRegion);
                // return createErrorResponse(404, "not_found_error", "Not Found");
        }
    } catch (error) {
        console.error(error);
        return createErrorResponse(500, "api_error", "An unexpected error occurred");
    }
}
 
async function handleMessagesEndpoint(request, api_token, project, region) {
    const anthropicVersion = request.headers.get('anthropic-version') || '2023-06-01';
    let anthropicBeta = request.headers.get('anthropic-beta') || '';
    if (anthropicVersion && anthropicVersion !== '2023-06-01') {
        return createErrorResponse(400, "invalid_request_error", "API version not supported");
    }

    let payload;
    try {
        payload = await request.json();
    } catch (err) {
        return createErrorResponse(400, "invalid_request_error", "The request body is not valid JSON.");
    }

    delete payload["n"]
    payload.anthropic_version = "vertex-2023-10-16";

    if (!payload.model) {
        return createErrorResponse(400, "invalid_request_error", "Missing model in the request payload.");
    } else if (!MODELS[payload.model]) {
        return createErrorResponse(400, "invalid_request_error", `Model \`${payload.model}\` not found.`);
    }

    if (payload.anthropic_beta) {
        anthropicBeta = payload.anthropic_beta.join(',');
        // if (typeof payload.anthropic_beta === "string") {
        //     anthropicBeta = payload.anthropic_beta;
        // }
    }

    const stream = payload.stream || false;
    const model = MODELS[payload.model];
    if (!region) {
        region = model.region;
    }
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${model.region}/publishers/anthropic/models/${model.vertexName}:streamRawPredict`;
    delete payload.model;

    let response, contentType
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${api_token}`,
                'Anthropic-Version': anthropicVersion,
                'Anthropic-Beta': anthropicBeta,
            },
            body: JSON.stringify(payload)
        });
        contentType = response.headers.get("Content-Type") || "application/json";
    } catch (error) {
        return createErrorResponse(500, "api_error", "Server Error");
    }

    if (stream && contentType.startsWith('text/event-stream')) {
        if (!(response.body instanceof ReadableStream)) {
            return createErrorResponse(500, "api_error", "Server Error");
        }

        const encoder = new TextEncoder();
        const decoder = new TextDecoder("utf-8");
        let buffer = '';
        let { readable, writable } = new TransformStream({
            transform(chunk, controller) {
                let decoded = decoder.decode(chunk, { stream: true });
                buffer += decoded
                let eventList = buffer.split(/\r\n\r\n|\r\r|\n\n/g);
                if (eventList.length === 0) return;
                buffer = eventList.pop();

                for (let event of eventList) {
                    controller.enqueue(encoder.encode(`${event}\n\n`));
                }
            },
        });
        response.body.pipeTo(writable);
        return new Response(readable, {
            status: response.status,
            headers: {
                "Content-Type": response.headers.get("Content-Type") || "text/event-stream",
                "Access-Control-Allow-Origin": "*",
            },
        });
    } else {
        try {
            let data = await response.text();
            let responseData = null;
            
            try {
                responseData = JSON.parse(data);
                if (responseData.usage) {
                    responseData.usage = {
                        ...responseData.usage,
                        prompt_tokens: responseData.usage.input_tokens,
                        completion_tokens: responseData.usage.output_tokens,
                        total_tokens: responseData.usage.input_tokens + responseData.usage.output_tokens
                    };
                }
                data = JSON.stringify(responseData);
            } catch (parseError) {
                // 如果解析失败，保持原始数据
            }
            
            return new Response(data, {
                status: response.status,
                headers: {
                    "Content-Type": contentType,
                    "Access-Control-Allow-Origin": "*",
                },
            });
        } catch (error) {
            return createErrorResponse(500, "api_error", "Server Error");
        }
    }
}

function createErrorResponse(status, errorType, message) {
    const errorObject = { type: "error", error: { type: errorType, message: message } };
    return new Response(JSON.stringify(errorObject), {
        status: status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

async function createSignedJWT(email, pkey) {
    pkey = pkey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\r|\n|\\n/g, "");
    let cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        str2ab(atob(pkey)),
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: { name: "SHA-256" },
        },
        false,
        ["sign"]
    );

    const authUrl = "https://www.googleapis.com/oauth2/v4/token";
    const issued = Math.floor(Date.now() / 1000);
    const expires = issued + 600;

    const header = {
        alg: "RS256",
        typ: "JWT",
    };

    const payload = {
        iss: email,
        aud: authUrl,
        iat: issued,
        exp: expires,
        scope: "https://www.googleapis.com/auth/cloud-platform",
    };

    const encodedHeader = urlSafeBase64Encode(JSON.stringify(header));
    const encodedPayload = urlSafeBase64Encode(JSON.stringify(payload));

    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        str2ab(unsignedToken)
    );

    const encodedSignature = urlSafeBase64Encode(signature);
    return `${unsignedToken}.${encodedSignature}`;
}

async function exchangeJwtForAccessToken(signed_jwt) {
    const auth_url = "https://www.googleapis.com/oauth2/v4/token";
    const params = {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signed_jwt,
    };

    const r = await fetch(auth_url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: Object.entries(params)
            .map(([k, v]) => k + "=" + v)
            .join("&"),
    }).then((res) => res.json());

    if (r.access_token) {
        return [r.access_token, ""];
    }

    return [null, JSON.stringify(r)];
}

function str2ab(str) {
    const buffer = new ArrayBuffer(str.length);
    let bufferView = new Uint8Array(buffer);
    for (let i = 0; i < str.length; i++) {
        bufferView[i] = str.charCodeAt(i);
    }
    return buffer;
}

function urlSafeBase64Encode(data) {
    let base64 = typeof data === "string" ? btoa(encodeURIComponent(data).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode(parseInt("0x" + p1)))) : btoa(String.fromCharCode(...new Uint8Array(data)));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}