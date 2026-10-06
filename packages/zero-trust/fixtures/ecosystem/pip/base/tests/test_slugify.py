from slugify import slugify


def test_lowercases_single_words():
    assert slugify("Hello") == "hello"
