"""
Check Am — /api/search
Vercel serverless function
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(__file__))
from modules.agent import run_agent

_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")


def handler(request):
    """Vercel Python serverless handler"""
    from http.server import BaseHTTPRequestHandler

    if request.method == "OPTIONS":
        return _cors_response(200, "")

    if request.method != "POST":
        return _json_response(405, {"error": "Method not allowed"})

    try:
        body = json.loads(request.body)
    except Exception:
        return _json_response(400, {"error": "Invalid JSON"})

    entity = body.get("entity", "").strip()
    entity_type = body.get("type", "company")

    if not entity:
        return _json_response(400, {"error": "No entity provided"})

    if not _API_KEY:
        return _json_response(503, {"error": "Service not configured. Set ANTHROPIC_API_KEY in Vercel environment variables."})

    if entity_type == "company":
        prompt = (
            f"Run a complete due diligence check on the Nigerian company: {entity}. "
            "Provide a full intelligence report."
        )
    else:
        prompt = (
            f"Run a complete background check on the Nigerian individual: {entity}. "
            "Provide a full intelligence briefing."
        )

    try:
        result = run_agent(prompt, [], _API_KEY)
        return _json_response(200, result)
    except Exception as e:
        return _json_response(500, {"error": str(e)})


def _json_response(status, data):
    body = json.dumps(data)
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
        "body": body,
    }


def _cors_response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
        "body": body,
    }
