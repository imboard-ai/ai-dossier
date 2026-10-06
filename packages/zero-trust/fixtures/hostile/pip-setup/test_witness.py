"""Test phase of the pip containment witness (run with `python3 -m unittest`)."""
import unittest

from witness import witness


class WitnessTest(unittest.TestCase):
    def test_records_containment(self):
        witness("test")


if __name__ == "__main__":
    unittest.main()
