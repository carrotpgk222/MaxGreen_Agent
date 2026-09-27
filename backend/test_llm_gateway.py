import json
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

base_url = os.getenv("LLM_GATEWAY_URL", "").rstrip("/")
api_key = os.getenv("LLM_GATEWAY_API_KEY")
model = os.getenv("LLM_MODEL")

if not base_url:
    raise RuntimeError("LLM_GATEWAY_URL is missing")

if not api_key:
    raise RuntimeError("LLM_GATEWAY_API_KEY is missing")

if not model:
    raise RuntimeError("LLM_MODEL is missing")

url = f"{base_url}/api/chat"

headers = {
    "Content-Type": "application/json",
    "x-api-key": api_key
}

payload = {
    "model": model,
    "messages": [
        {
            "role": "user",
            "content": 'Reply with JSON only: {"status":"ok"}'
        }
    ],
    "stream": False
}

print("Testing Claude gateway...")
print("Endpoint:", url)
print("Model:", model)

try:
    response = requests.post(
        url,
        headers=headers,
        json=payload,
        timeout=60
    )

    print("HTTP status:", response.status_code)

    try:
        print(json.dumps(response.json(), indent=2))
    except ValueError:
        print(response.text)

except requests.RequestException as error:
    print("Request failed:")
    print(error)