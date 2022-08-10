from typing import Any, Dict, Generator, List, Optional, Tuple


def process_raw_response(response: List[Dict[str, Any]], fields: List[str]) -> Dict[str, Any]:
    """Process the response further into the expected output."""
    normalize_fields(response)
    restricted_response = restrict_response_by_fields(fields, response)
    return restricted_response


def normalize_fields(response: List[Dict[str, Any]]) -> None:
    """For each payload in the response strip "agg_" prefixes."""
    for item in response:
        item["replayId"] = item.pop("replay_id")
        item["longestTransaction"] = 0
        item["environment"] = item.pop("agg_environment")
        item["tags"] = dict(zip(item.pop("tags.key") or [], item.pop("tags.value") or []))
        item["user"] = {
            "id": item.pop("user_id"),
            "name": item.pop("user_name"),
            "email": item.pop("user_email"),
            "ipAddress": item.pop("user_ipAddress"),
        }

        item["urls"] = list(generate_sorted_urls(item.pop("agg_urls")))
        item["countUrls"] = len(item["urls"])


def restrict_response_by_fields(
    fields: Optional[List[str]],
    payload: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Return only the fields requested by the client."""
    if fields:
        return [{field: item[field] for field in fields} for item in payload]
    else:
        return payload


def generate_sorted_urls(url_groups: List[Tuple[int, List[str]]]) -> Generator[None, None, str]:
    """Return a flat list of ordered urls."""
    for _, url_group in sorted(url_groups, key=lambda item: item[0]):
        yield from url_group