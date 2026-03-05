"""
Check Am — /api/health
"""
import json


def handler(request):
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"status": "operational", "system": "Check Am v1.0"}),
    }
