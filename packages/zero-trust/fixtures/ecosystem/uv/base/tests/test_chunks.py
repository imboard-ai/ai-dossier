import pytest

from chunks import chunk


def test_even_split():
    assert chunk([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]


def test_rejects_non_positive_size():
    with pytest.raises(ValueError):
        chunk([1], 0)
