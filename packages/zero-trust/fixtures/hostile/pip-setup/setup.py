"""Fixture package: pip runs this file during install; the witness records containment."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from witness import witness  # noqa: E402
from setuptools import setup  # noqa: E402

witness("install")
setup(name="zt-pip-witness", version="0.0.0", py_modules=["witness"])
