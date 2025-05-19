import streamlit as st

import re
import unicodedata
import struct
import hashlib
import numpy as np

import sys as _sys
if (_sys.version_info > (3, 0)):
    def xrange( a, b, c ):
        return range( a, b, c )
    def xencode(x):
        if isinstance(x, bytes) or isinstance(x, bytearray):
            return x
        else:
            return x.encode()
else:
    def xencode(x):
        return x
del _sys

def mmh3_hash_py(key, seed=0x0, signed=False):
    """Implements 32bit murmur3 hash."""

    key = bytearray(xencode(key))

    def fmix(h):
        h ^= h >> 16
        h = (h * 0x85EBCA6B) & 0xFFFFFFFF
        h ^= h >> 13
        h = (h * 0xC2B2AE35) & 0xFFFFFFFF
        h ^= h >> 16
        return h

    length = len(key)
    nblocks = int(length / 4)

    h1 = seed

    c1 = 0xCC9E2D51
    c2 = 0x1B873593

    # body
    for block_start in xrange(0, nblocks * 4, 4):
        # ??? big endian?
        k1 = (
            key[block_start + 3] << 24
            | key[block_start + 2] << 16
            | key[block_start + 1] << 8
            | key[block_start + 0]
        )

        k1 = (c1 * k1) & 0xFFFFFFFF
        k1 = (k1 << 15 | k1 >> 17) & 0xFFFFFFFF  # inlined ROTL32
        k1 = (c2 * k1) & 0xFFFFFFFF

        h1 ^= k1
        h1 = (h1 << 13 | h1 >> 19) & 0xFFFFFFFF  # inlined ROTL32
        h1 = (h1 * 5 + 0xE6546B64) & 0xFFFFFFFF

    # tail
    tail_index = nblocks * 4
    k1 = 0
    tail_size = length & 3

    if tail_size >= 3:
        k1 ^= key[tail_index + 2] << 16
    if tail_size >= 2:
        k1 ^= key[tail_index + 1] << 8
    if tail_size >= 1:
        k1 ^= key[tail_index + 0]

    if tail_size > 0:
        k1 = (k1 * c1) & 0xFFFFFFFF
        k1 = (k1 << 15 | k1 >> 17) & 0xFFFFFFFF  # inlined ROTL32
        k1 = (k1 * c2) & 0xFFFFFFFF
        h1 ^= k1

    # finalization
    unsigned_val = fmix(h1 ^ length)
    if not signed:
        return unsigned_val

    if unsigned_val & 0x80000000 == 0:
        return unsigned_val
    else:
        return -((unsigned_val ^ 0xFFFFFFFF) + 1)

URL_PATTERN = re.compile(r'https?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+')

def remove_url(text: str):
    text = URL_PATTERN.sub("", text)
    return text

def text_collapse(text):
    # Decompose with NFD and convert to lower case
    text = unicodedata.normalize("NFD", text).lower()

    # Remove whitespace and filter characters in one pass
    filtered_chars = []

    for ch in text:
        ch_type = unicodedata.category(ch)
        if ch_type[0] == "L":
            filtered_chars.append(ch)
        elif ch_type[0] == "Z" and len(filtered_chars) > 0 and filtered_chars[-1] != " ":
            filtered_chars.append(" ")

    # Recombine
    return unicodedata.normalize("NFKC", "".join(filtered_chars)).strip()

def clean_text(text: str):
    text = remove_url(text)
    text = text_collapse(text)
    return text

# Custom N-gram tokenization, consistent with Nemo
def ngrams(text, n=24):
    text = text.lower()
    if len(text) < n:
        return set()
    return [text[i:i + n] for i in range(len(text) - n + 1)]

class MinHash:
    def __init__(self, num_perm=260, seed=42, hashfunc=None):
        self.num_perm = num_perm
        self.seed = seed
        self.hashfunc = hashfunc or (lambda x: mmh3_hash_py(x, seed=seed, signed=False))
        self.hashvalues = np.ones(num_perm, dtype=np.uint64) * np.uint64((1 << 32) - 1)
        self.permutations = self._get_permutation_functions(num_perm, seed)
        
    def _get_permutation_functions(self, num_perm, seed):
        rng = np.random.RandomState(seed)
        mersenne_prime = np.uint64((1 << 61) - 1)
        max_hash = np.uint64((1 << 32) - 1)
        
        return np.array([
            (rng.randint(1, mersenne_prime, dtype=np.uint64), 
             rng.randint(0, mersenne_prime, dtype=np.uint64))
            for _ in range(num_perm)
        ], dtype=np.uint64).T
        
    def update(self, b):
        hv = self.hashfunc(b)
        a, b = self.permutations
        phv = np.bitwise_and(
            ((hv * a + b) % np.uint64((1 << 61) - 1)),
            np.uint64((1 << 32) - 1)
        )
        self.hashvalues = np.minimum(self.hashvalues, phv)
        
    def jaccard(self, other):
        if other.num_perm != self.num_perm:
            raise ValueError("Cannot compare MinHash with different num_perm")
        return np.sum(self.hashvalues == other.hashvalues) / self.num_perm

def minhash(text, num_perm=260, gram=24, seed=42):
    m = MinHash(num_perm=num_perm, seed=seed, hashfunc=lambda x: mmh3_hash_py(x, seed=seed, signed=False))
    grams = ngrams(text, n=gram)
    if not grams:
        # Only return empty signature
        return m
    for g in grams:
        m.update(g.encode("utf-8"))
    return m

def mmh3_hash32(data):
    def get_hash_func():
        if "hash_func" not in globals():
            from mmh3 import hash as mmh3_hash
            globals()["hash_func"] = mmh3_hash
        return globals()["hash_func"]

    hash = get_hash_func()
    return hash(data, signed=False)

def sha1_hash32(data):
    return struct.unpack("<I", hashlib.sha1(data).digest()[:4])[0]

def get_ngrams_nvidia_style(text: str, width: int) -> set[str]:
    """
    Implements n-gram generation similar to NVIDIA cuDF approach.
    Uses character-level sliding window instead of word tokenization.
    Returns unique n-grams as a set.
    
    Args:
        text: Input text string
        width: Size of the sliding window (n-gram width)
        
    Returns:
        Set of unique n-gram strings
    """
    if not text or len(text) < width:
        yield 
        
    # Convert to lowercase like NVIDIA implementation
    text = text.lower()
    
    # Create character level n-grams as a set
    for i in range(len(text) - width + 1):
        yield text[i:i + width]

SEED = 42
RNG = np.random.RandomState(SEED)
MAX_HASH = np.uint64((1 << 32) - 1)
MERSENNE_PRIME = np.uint64((1 << 61) - 1)
threshold = 0.8
num_perm = 260
ngram_size = 24
B, R = 20, 13


HASH_RANGES = [(i * R, (i + 1) * R) for i in range(B)]
PERMUTATIONS = np.array(
    [
        (
            RNG.randint(1, MERSENNE_PRIME, dtype=np.uint64),
            RNG.randint(0, MERSENNE_PRIME, dtype=np.uint64),
        )
        for _ in range(num_perm)
    ],
    dtype=np.uint64,
).T

def generate_hash_values(row):
    idx = str(row[0])
    content = row[1]

    # tokens =minhash_tokenizer(content)
    # logger.debug(f"Processing content=[{content[:40]}]]")
    a, b = PERMUTATIONS
    hashvalues = np.ones(num_perm, dtype=np.uint64) * MAX_HASH
    # tokens = list(map(str, tokens))
    ngrams = get_ngrams_nvidia_style(content, width=ngram_size)
    # print(list(ngrams))
    hv = np.array([mmh3_hash32(ngram.encode("utf-8")) for ngram in ngrams], dtype=np.uint64)
    phv = np.bitwise_and(((hv * np.tile(a, (len(hv), 1)).T).T + b) % MERSENNE_PRIME, MAX_HASH)
    hashvalues = np.vstack([phv, hashvalues]).min(axis=0)
    Hs = [bytes(hashvalues[start:end].byteswap().data) for start, end in HASH_RANGES]
    for band_idx, H in enumerate(Hs):
        yield band_idx, H.hex(), idx


def generate_hash_values_new(row):
    idx = str(row[0])
    content = row[1]

    text = content.lower()

    a, b = PERMUTATIONS
    hashvalues = np.ones(num_perm, dtype=np.uint64) * MAX_HASH

    if len(text) >= ngram_size:
        
        batch_size = 100

        for i in range(0, len(text) - ngram_size + 1, batch_size):
            batch_end = min(i + batch_size, len(text) - ngram_size + 1)
            tokens = {text[j:j+ngram_size].encode('utf-8') for j in range(i, batch_end)}
            
            hv = np.array([mmh3_hash32(token) for token in tokens], dtype=np.uint64)
            # hv = np.array([sha1_hash32(token) for token in tokens], dtype=np.uint64)
            phv = np.bitwise_and(
                ((hv * np.tile(a, (len(tokens), 1)).T).T + b) % MERSENNE_PRIME,
                MAX_HASH
            )
            # hashvalues = np.vstack([phv, hashvalues]).min(axis=0)
            phv = phv.min(axis=0)
            hashvalues = np.minimum(hashvalues, phv)


        Hs = [bytes(hashvalues[start:end].byteswap().data) for start, end in HASH_RANGES]
        for band_idx, H in enumerate(Hs):
            yield band_idx, H.hex(), idx

def generate_hash_values_auto_fallback(row):
    res = None
    try:
        res = list(generate_hash_values_new(row))
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(e,flush=True)
    
    if not res:
        try:
            res = list(generate_hash_values(row))
        except Exception as e:
            print(e,flush=True)
    
    if res:
        for item in res:
            yield item

st.title("MinHash 24-gram Jaccard (Nemotron CC pipeline)")

text_a = st.text_area("Enter text A", height=100)
text_b = st.text_area("Enter text B", height=100)
# num_perm = st.slider("MinHash permutation count (num_perm)", 20, 512, 260, step=1)

text_a = text_a.replace("。", "\n")
text_b = text_b.replace("。", "\n")

clean_texts = st.checkbox("Clean texts", value=True)
if clean_texts:
    text_a = clean_text(text_a)
    text_b = clean_text(text_b)

if st.button("Calculate MinHash Jaccard similarity"):
    if not text_a or not text_b:
        st.warning("Please enter two texts")
    else:
        m1 = minhash(text_a, num_perm=num_perm)
        m2 = minhash(text_b, num_perm=num_perm)
        sim_minhash = m1.jaccard(m2)

        # Display real Jaccard for reference
        set_a = set(ngrams(text_a, 24))
        set_b = set(ngrams(text_b, 24))
        if set_a or set_b:
            real_jaccard = len(set_a & set_b) / len(set_a | set_b)
        else:
            real_jaccard = 0.0

        st.write(f"**MinHash-Jaccard approximate similarity:** `{sim_minhash:.4f}` (Real Jaccard = `{real_jaccard:.4f}`)")

        hit_cnt = 0
        total_cnt = 0
        a = generate_hash_values_auto_fallback((0, text_a))
        b = generate_hash_values_auto_fallback((0, text_b))
        for (band_idx, H, idx), (band_idx2, H2, idx2) in zip(a, b):
            if band_idx == band_idx2 and H == H2:
                hit_cnt += 1
            total_cnt += 1

        # Display hit count and total band count
        if total_cnt > 0:
            hit_ratio = hit_cnt/total_cnt
            st.write(f"**Band hits:** `{hit_cnt}/{total_cnt}` (Dedup if any band is hit)")
            
            # Visualization of band hits
            progress_bar = st.progress(0)
            progress_bar.progress(hit_ratio)

