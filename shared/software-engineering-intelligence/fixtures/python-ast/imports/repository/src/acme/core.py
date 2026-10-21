import os
import acme.helpers
import acme.helpers
import acme.missing
from acme.sub import leaf
from acme import helpers, missing
from .sub import leaf
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from acme.namespace import tool

import importlib

__import__("acme.helpers")
importlib.import_module("acme.helpers")


def choose(values, flag):
    if flag and values:
        return [value for value in values if value]
    assert values
    return 0


def outer(value):
    def inner(candidate):
        return candidate if candidate else 0

    import acme.helpers
    return inner(value)
