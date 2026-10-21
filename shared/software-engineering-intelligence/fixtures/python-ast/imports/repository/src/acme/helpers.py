from . import core


async def helper(items):
    for item in items:
        if item:
            return item
    return None
