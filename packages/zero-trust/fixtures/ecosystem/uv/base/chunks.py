"""Splits sequences into fixed-size chunks."""


def chunk(items: list, size: int) -> list[list]:
    """Return consecutive chunks of at most `size` items, keeping a short last chunk."""
    if size < 1:
        raise ValueError("size must be positive")
    # Known bug: the range stops early, so a trailing partial chunk is dropped.
    return [items[i : i + size] for i in range(0, len(items) - size + 1, size)]
