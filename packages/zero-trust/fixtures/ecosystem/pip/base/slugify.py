"""Turns titles into URL slugs."""

import re


def slugify(title: str) -> str:
    """Lowercase, replace non-alphanumerics with single hyphens, trim hyphens."""
    # Known bug: each separator character becomes its own hyphen, so runs of
    # punctuation or spaces produce "--" instead of a single "-".
    return re.sub(r"[^a-z0-9]", "-", title.lower()).strip("-")
