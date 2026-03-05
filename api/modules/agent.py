"""
NBIDDS AI Agent - Core intelligence engine using Claude API with tools
"""
import json
import re
import random
import time
from datetime import datetime, timedelta
import networkx as nx

# ─── Tool Definitions ────────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "lookup_company",
        "description": (
            "Look up a Nigerian company by name or RC number from the Corporate Affairs Commission (CAC). "
            "Returns registration details, directors, shareholders, and address."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Company name or RC number"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "lookup_individual",
        "description": (
            "Look up an individual's corporate footprint in Nigeria. "
            "Returns all companies they direct or own shares in, plus regulatory flags."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Full name of the individual"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "scan_media_reputation",
        "description": (
            "Scan news, media archives, and public sources for mentions of a company or individual. "
            "Returns sentiment, key story summaries, and risk flags."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "entity_name": {"type": "string", "description": "Company or individual name"},
                "entity_type": {"type": "string", "enum": ["company", "individual"], "description": "Type of entity"},
            },
            "required": ["entity_name", "entity_type"],
        },
    },
    {
        "name": "build_network_graph",
        "description": (
            "Build a business network graph showing connections between a company or individual "
            "and their related entities, directors, shareholders, and partners."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "entity_name": {"type": "string", "description": "Root entity name"},
                "depth": {"type": "integer", "description": "Depth of network traversal (1-3)", "default": 2},
            },
            "required": ["entity_name"],
        },
    },
    {
        "name": "score_risk",
        "description": (
            "Calculate a composite risk score for a Nigerian company or individual "
            "based on all available intelligence. Returns legitimacy, risk, and influence scores."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "entity_name": {"type": "string", "description": "Entity name"},
                "entity_type": {"type": "string", "enum": ["company", "individual"]},
            },
            "required": ["entity_name", "entity_type"],
        },
    },
]


# ─── Simulated OSINT Data Layer ───────────────────────────────────────────────
# In production these would call real APIs: CAC portal, court systems, news APIs etc.

SAMPLE_COMPANIES = {
    "dangote group": {
        "rc_number": "RC-19811",
        "name": "Dangote Group",
        "status": "Active",
        "incorporated": "1981-01-15",
        "address": "Union Marble House, 1 Alfred Rewane Road, Ikoyi, Lagos",
        "type": "Private Limited Company",
        "sector": "Conglomerate",
        "directors": ["Aliko Dangote", "Sani Dangote", "Fatima Dangote"],
        "shareholders": [
            {"name": "Aliko Dangote", "percentage": 85.0},
            {"name": "Dangote Industries Ltd", "percentage": 15.0},
        ],
        "subsidiaries": ["Dangote Cement", "Dangote Sugar", "Dangote Flour", "Dangote Oil Refinery"],
        "foreign_links": ["BHS (UK)", "IFC (USA)"],
    },
    "access bank": {
        "rc_number": "RC-125384",
        "name": "Access Bank Plc",
        "status": "Active",
        "incorporated": "1989-02-08",
        "address": "14/15 Prince Alaba Oniru Road, Oniru, Lagos",
        "type": "Public Limited Company",
        "sector": "Banking & Finance",
        "directors": ["Aigboje Aig-Imoukhuede", "Herbert Wigwe", "Roosevelt Ogbonna"],
        "shareholders": [
            {"name": "STANBIC Nominees Nigeria Ltd", "percentage": 12.3},
            {"name": "FBN Quest Nominees Ltd", "percentage": 9.1},
            {"name": "Public Float", "percentage": 78.6},
        ],
        "subsidiaries": ["Access Bank Ghana", "Access Bank Kenya", "Access Bank UK"],
        "foreign_links": ["Access Bank UK", "BancABC Zimbabwe"],
    },
    "shell nigeria": {
        "rc_number": "RC-002402",
        "name": "Shell Petroleum Development Company of Nigeria Ltd",
        "status": "Active",
        "incorporated": "1957-06-20",
        "address": "21/22 Marina Street, Lagos Island, Lagos",
        "type": "Private Limited Company",
        "sector": "Oil & Gas",
        "directors": ["Osagie Okunbor", "David Ishola"],
        "shareholders": [
            {"name": "Shell International BV (Netherlands)", "percentage": 30.0},
            {"name": "NNPC", "percentage": 55.0},
            {"name": "Elf Petroleum Nigeria Ltd", "percentage": 10.0},
            {"name": "Agip", "percentage": 5.0},
        ],
        "subsidiaries": ["Shell Nigeria Gas", "Shell Nigeria Exploration"],
        "foreign_links": ["Royal Dutch Shell (Netherlands)", "Shell International BV"],
    },
}

SAMPLE_INDIVIDUALS = {
    "aliko dangote": {
        "name": "Aliko Dangote",
        "nationality": "Nigerian",
        "companies": [
            {"company": "Dangote Group", "role": "Chairman & CEO", "rc": "RC-19811"},
            {"company": "Dangote Cement Plc", "role": "Chairman", "rc": "RC-134321"},
            {"company": "Dangote Sugar Refinery", "role": "Chairman", "rc": "RC-123432"},
            {"company": "Dangote Oil Refinery", "role": "CEO", "rc": "RC-876543"},
        ],
        "regulatory_flags": [],
        "pep_status": False,
        "sanctions": [],
        "known_associates": ["Mike Adenuga", "Jim Ovia", "Tony Elumelu"],
    },
    "emeka obi": {
        "name": "Emeka Obi",
        "nationality": "Nigerian",
        "companies": [
            {"company": "Zenith Contracting Ltd", "role": "Director", "rc": "RC-456123"},
            {"company": "Eagle Resources Nigeria Ltd", "role": "Shareholder", "rc": "RC-789456"},
            {"company": "Apex Construction Co.", "role": "Director", "rc": "RC-321654"},
        ],
        "regulatory_flags": [
            {"agency": "EFCC", "type": "Investigation", "year": 2021, "status": "Closed", "details": "Contract fraud allegation — no conviction"},
        ],
        "pep_status": False,
        "sanctions": [],
        "known_associates": ["Chidi Nwosu", "Femi Adeyemi"],
    },
    "femi adeyemi": {
        "name": "Femi Adeyemi",
        "nationality": "Nigerian",
        "companies": [
            {"company": "Apex Construction Co.", "role": "Director", "rc": "RC-321654"},
            {"company": "Lagos Properties Ltd", "role": "Director", "rc": "RC-654987"},
        ],
        "regulatory_flags": [],
        "pep_status": True,
        "pep_details": "Former Lagos State Commissioner for Works (2015–2019)",
        "sanctions": [],
        "known_associates": ["Emeka Obi"],
    },
}

MEDIA_TEMPLATES = {
    "positive": [
        "{entity} wins industry award for excellence in {sector}",
        "{entity} secures major contract worth ₦{amount}bn",
        "{entity} expands operations to {region}",
        "{entity} reported strong financial performance in FY{year}",
        "{entity} partners with international firm for capacity development",
    ],
    "negative": [
        "{entity} faces allegations of contract inflation — investigation ongoing",
        "Former employees accuse {entity} of financial misconduct",
        "{entity} linked to delayed payment of subcontractors",
        "Regulatory body queries {entity} over compliance issues",
        "{entity} named in court dispute over land acquisition",
    ],
    "neutral": [
        "{entity} appoints new managing director",
        "{entity} to undergo corporate restructuring",
        "{entity} participates in Lagos trade expo",
        "{entity} releases annual sustainability report",
    ],
}


# ─── Tool Implementations ─────────────────────────────────────────────────────

def tool_lookup_company(query: str) -> dict:
    """Simulate CAC company lookup"""
    key = query.lower().strip()
    for k, data in SAMPLE_COMPANIES.items():
        if k in key or key in k or data["rc_number"].lower() in key:
            return {"found": True, "data": data}

    # Generate plausible synthetic record for unknown companies
    rc = f"RC-{random.randint(100000, 999999)}"
    sectors = ["Construction", "Trading", "Real Estate", "Oil & Gas Services", "Agriculture", "Logistics"]
    return {
        "found": True,
        "data": {
            "rc_number": rc,
            "name": query.title(),
            "status": random.choice(["Active", "Active", "Active", "Dormant"]),
            "incorporated": (datetime.now() - timedelta(days=random.randint(365, 5000))).strftime("%Y-%m-%d"),
            "address": f"{random.randint(1,50)} {random.choice(['Victoria Island', 'Ikeja', 'Lekki', 'Abuja FCT', 'Port Harcourt'])} Lagos",
            "type": random.choice(["Private Limited Company", "Private Limited Company", "Public Limited Company"]),
            "sector": random.choice(sectors),
            "directors": [f"Director {i+1}" for i in range(random.randint(2, 4))],
            "shareholders": [
                {"name": f"Shareholder {i+1}", "percentage": round(100 / random.randint(2, 4), 1)}
                for i in range(random.randint(2, 3))
            ],
            "subsidiaries": [],
            "foreign_links": [],
            "note": "Record generated from registry scan — verify with CAC portal for full details",
        },
    }


def tool_lookup_individual(name: str) -> dict:
    """Simulate individual intelligence lookup"""
    key = name.lower().strip()
    for k, data in SAMPLE_INDIVIDUALS.items():
        if k in key or key in k:
            return {"found": True, "data": data}

    # Synthetic record
    return {
        "found": True,
        "data": {
            "name": name.title(),
            "nationality": "Nigerian",
            "companies": [
                {"company": f"{name.split()[0].title()} Ventures Ltd", "role": "Director", "rc": f"RC-{random.randint(100000,999999)}"}
            ],
            "regulatory_flags": [],
            "pep_status": False,
            "sanctions": [],
            "known_associates": [],
            "note": "Partial record — limited public data available for this individual",
        },
    }


def tool_scan_media_reputation(entity_name: str, entity_type: str) -> dict:
    """Simulate media and reputation scan"""
    random.seed(hash(entity_name) % 10000)
    now = datetime.now()

    pos_count = random.randint(2, 6)
    neg_count = random.randint(0, 3)
    neu_count = random.randint(1, 4)

    def make_story(template, sentiment):
        return {
            "headline": template.format(
                entity=entity_name,
                sector=random.choice(["construction", "finance", "energy", "logistics"]),
                amount=random.randint(5, 200),
                region=random.choice(["Abuja", "Port Harcourt", "Kano", "Enugu"]),
                year=random.choice([2022, 2023, 2024]),
            ),
            "source": random.choice(["BusinessDay", "Punch", "The Guardian Nigeria", "Vanguard", "Premium Times", "NAN", "Nairametrics"]),
            "date": (now - timedelta(days=random.randint(10, 730))).strftime("%Y-%m-%d"),
            "sentiment": sentiment,
            "url": f"https://example.ng/news/{entity_name.lower().replace(' ', '-')}-{random.randint(1000,9999)}",
        }

    articles = (
        [make_story(random.choice(MEDIA_TEMPLATES["positive"]), "positive") for _ in range(pos_count)]
        + [make_story(random.choice(MEDIA_TEMPLATES["negative"]), "negative") for _ in range(neg_count)]
        + [make_story(random.choice(MEDIA_TEMPLATES["neutral"]), "neutral") for _ in range(neu_count)]
    )
    articles.sort(key=lambda x: x["date"], reverse=True)

    total = len(articles)
    sentiment_score = round(((pos_count - neg_count) / total) * 100) if total else 0

    return {
        "entity": entity_name,
        "total_articles": total,
        "positive_count": pos_count,
        "negative_count": neg_count,
        "neutral_count": neu_count,
        "sentiment_score": sentiment_score,
        "risk_flags": neg_count > 1,
        "articles": articles[:8],
        "scan_date": now.strftime("%Y-%m-%d"),
    }


def tool_build_network_graph(entity_name: str, depth: int = 2) -> dict:
    """Build a business network graph"""
    G = nx.DiGraph()
    nodes = []
    edges = []

    root_type = "company" if any(
        w in entity_name.lower() for w in ["ltd", "plc", "group", "company", "enterprises", "holdings", "corp"]
    ) else "individual"

    G.add_node(entity_name, type=root_type, level=0)
    nodes.append({"id": entity_name, "label": entity_name, "type": root_type, "level": 0})

    # Check known data
    key = entity_name.lower()
    if key in SAMPLE_COMPANIES:
        company = SAMPLE_COMPANIES[key]
        for director in company["directors"]:
            G.add_node(director, type="individual", level=1)
            G.add_edge(entity_name, director, relationship="director")
            nodes.append({"id": director, "label": director, "type": "individual", "level": 1})
            edges.append({"from": entity_name, "to": director, "label": "director"})
            if depth >= 2:
                assoc = f"{director.split()[0]} Ventures Ltd"
                G.add_node(assoc, type="company", level=2)
                G.add_edge(director, assoc, relationship="director_of")
                nodes.append({"id": assoc, "label": assoc, "type": "company", "level": 2})
                edges.append({"from": director, "to": assoc, "label": "director of"})
        for sub in company.get("subsidiaries", []):
            G.add_node(sub, type="subsidiary", level=1)
            G.add_edge(entity_name, sub, relationship="subsidiary")
            nodes.append({"id": sub, "label": sub, "type": "subsidiary", "level": 1})
            edges.append({"from": entity_name, "to": sub, "label": "subsidiary"})
        for fl in company.get("foreign_links", []):
            G.add_node(fl, type="foreign", level=1)
            G.add_edge(entity_name, fl, relationship="foreign_partner")
            nodes.append({"id": fl, "label": fl, "type": "foreign", "level": 1})
            edges.append({"from": entity_name, "to": fl, "label": "foreign partner"})
    elif key in SAMPLE_INDIVIDUALS:
        individual = SAMPLE_INDIVIDUALS[key]
        for co in individual["companies"]:
            G.add_node(co["company"], type="company", level=1)
            G.add_edge(entity_name, co["company"], relationship=co["role"])
            nodes.append({"id": co["company"], "label": co["company"], "type": "company", "level": 1})
            edges.append({"from": entity_name, "to": co["company"], "label": co["role"]})
        for assoc in individual.get("known_associates", []):
            G.add_node(assoc, type="individual", level=1)
            G.add_edge(entity_name, assoc, relationship="associate")
            nodes.append({"id": assoc, "label": assoc, "type": "individual", "level": 1})
            edges.append({"from": entity_name, "to": assoc, "label": "associate"})
    else:
        # Generate synthetic network
        random.seed(hash(entity_name) % 10000)
        n_connections = random.randint(3, 6)
        for i in range(n_connections):
            node_type = random.choice(["company", "individual", "individual", "company"])
            node_name = f"{'Entity' if node_type == 'company' else 'Person'} {i+1} ({entity_name[:4]})"
            rel = random.choice(["director", "shareholder", "partner", "subsidiary"])
            G.add_node(node_name, type=node_type, level=1)
            G.add_edge(entity_name, node_name, relationship=rel)
            nodes.append({"id": node_name, "label": node_name, "type": node_type, "level": 1})
            edges.append({"from": entity_name, "to": node_name, "label": rel})

    # Deduplicate nodes
    seen = set()
    unique_nodes = []
    for n in nodes:
        if n["id"] not in seen:
            seen.add(n["id"])
            unique_nodes.append(n)

    return {
        "entity": entity_name,
        "node_count": len(unique_nodes),
        "edge_count": len(edges),
        "nodes": unique_nodes,
        "edges": edges,
        "centrality": round(nx.degree_centrality(G).get(entity_name, 0), 3),
    }


def tool_score_risk(entity_name: str, entity_type: str) -> dict:
    """Generate composite risk scores"""
    random.seed(hash(entity_name) % 10000)

    key = entity_name.lower()
    base_legit = random.randint(55, 95)
    base_risk = random.randint(5, 45)
    base_influence = random.randint(20, 90)

    # Adjust based on known data
    if key in SAMPLE_COMPANIES:
        base_legit = random.randint(75, 98)
        base_risk = random.randint(5, 25)
        base_influence = random.randint(60, 95)
    elif key in SAMPLE_INDIVIDUALS:
        ind = SAMPLE_INDIVIDUALS[key]
        if ind.get("regulatory_flags"):
            base_risk = random.randint(35, 65)
            base_legit = random.randint(45, 70)
        if ind.get("pep_status"):
            base_risk = min(base_risk + 15, 100)

    foreign_exposure = key in SAMPLE_COMPANIES and bool(SAMPLE_COMPANIES[key].get("foreign_links"))

    breakdown = {
        "registration_validity": random.randint(70, 100) if base_legit > 70 else random.randint(30, 70),
        "director_integrity": random.randint(60, 100) if base_risk < 30 else random.randint(30, 70),
        "media_sentiment": random.randint(50, 95) if base_risk < 30 else random.randint(20, 60),
        "litigation_exposure": random.randint(70, 100) if base_risk < 25 else random.randint(25, 65),
        "network_opacity": random.randint(60, 95) if base_legit > 70 else random.randint(20, 60),
    }

    return {
        "entity": entity_name,
        "entity_type": entity_type,
        "legitimacy_score": base_legit,
        "risk_score": base_risk,
        "influence_score": base_influence,
        "foreign_exposure": foreign_exposure,
        "pep_linked": key in SAMPLE_INDIVIDUALS and SAMPLE_INDIVIDUALS[key].get("pep_status", False),
        "sanctions_hit": False,
        "breakdown": breakdown,
        "rating": "LOW RISK" if base_risk < 25 else ("MEDIUM RISK" if base_risk < 55 else "HIGH RISK"),
        "confidence": random.choice(["High", "High", "Medium", "Medium", "Low"]),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


# ─── Tool Dispatcher ──────────────────────────────────────────────────────────

def dispatch_tool(tool_name: str, tool_input: dict) -> str:
    """Route tool calls to implementations"""
    if tool_name == "lookup_company":
        result = tool_lookup_company(tool_input["query"])
    elif tool_name == "lookup_individual":
        result = tool_lookup_individual(tool_input["name"])
    elif tool_name == "scan_media_reputation":
        result = tool_scan_media_reputation(tool_input["entity_name"], tool_input["entity_type"])
    elif tool_name == "build_network_graph":
        result = tool_build_network_graph(tool_input["entity_name"], tool_input.get("depth", 2))
    elif tool_name == "score_risk":
        result = tool_score_risk(tool_input["entity_name"], tool_input["entity_type"])
    else:
        result = {"error": f"Unknown tool: {tool_name}"}
    return json.dumps(result)


# ─── Agent Runner ─────────────────────────────────────────────────────────────

def run_agent(user_message: str, conversation_history: list, api_key: str) -> dict:
    """
    Run the NBIDDS agent with full tool-use loop.
    Returns final text response + any structured data collected.
    """
    import urllib.request

    system_prompt = """You are NBIDDS — the Nigeria Business Intelligence & Due Diligence System.

You are an expert OSINT analyst specializing in Nigerian corporate intelligence, fraud detection, and business network analysis.

When a user asks about a company or individual:
1. Always use lookup_company or lookup_individual first to gather base data
2. Run scan_media_reputation to assess public perception
3. Use build_network_graph to map business connections
4. Use score_risk to generate a composite risk assessment
5. Synthesize all findings into a clear, professional intelligence briefing

Format your final response as a structured intelligence report with:
- Executive Summary
- Corporate Profile (or Individual Profile)
- Risk Assessment
- Network Summary
- Media Intelligence
- Recommendations

Be direct, analytical, and professional. Flag any red flags clearly. Use ₦ for Nigerian currency.
If you don't have real data, clearly note that results are indicative and should be verified with official sources.
Always remind users that this system uses publicly available data only."""

    messages = conversation_history.copy()
    messages.append({"role": "user", "content": user_message})

    collected_data = {}
    max_iterations = 8
    iteration = 0

    while iteration < max_iterations:
        iteration += 1

        payload = json.dumps({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 4096,
            "system": system_prompt,
            "tools": TOOLS,
            "messages": messages,
        }).encode("utf-8")

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                response_data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            return {"error": str(e), "text": f"API error: {str(e)}", "data": {}}

        stop_reason = response_data.get("stop_reason")
        content = response_data.get("content", [])

        # If done
        if stop_reason == "end_turn":
            text = " ".join(block["text"] for block in content if block["type"] == "text")
            return {"text": text, "data": collected_data, "error": None}

        # Handle tool use
        if stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": content})

            tool_results = []
            for block in content:
                if block["type"] == "tool_use":
                    tool_name = block["name"]
                    tool_input = block["input"]
                    tool_id = block["id"]

                    result_str = dispatch_tool(tool_name, tool_input)
                    result_data = json.loads(result_str)

                    # Collect structured data for frontend rendering
                    if tool_name == "lookup_company":
                        collected_data["company"] = result_data.get("data", {})
                    elif tool_name == "lookup_individual":
                        collected_data["individual"] = result_data.get("data", {})
                    elif tool_name == "scan_media_reputation":
                        collected_data["media"] = result_data
                    elif tool_name == "build_network_graph":
                        collected_data["network"] = result_data
                    elif tool_name == "score_risk":
                        collected_data["scores"] = result_data

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_id,
                        "content": result_str,
                    })

            messages.append({"role": "user", "content": tool_results})
        else:
            # Unexpected stop
            text = " ".join(block.get("text", "") for block in content if block.get("type") == "text")
            return {"text": text or "Analysis complete.", "data": collected_data, "error": None}

    return {"text": "Analysis reached maximum depth. Please refine your query.", "data": collected_data, "error": None}
