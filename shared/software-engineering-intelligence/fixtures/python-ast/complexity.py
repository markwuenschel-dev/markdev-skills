import importlib
import os, sys as system
from .pkg import alpha as renamed, beta

__import__("dynamic")
importlib.import_module("dynamic.module")

@decorate(lambda value: 1 if value else 0, __import__("decorator.plugin"))
def outer(values: (1 if False else 2) = (3 if True else 4)):
    result = {
        key: item
        for key, item in values
        if key
        for item in values
    }
    if result:
        pass

    def nested(flag):
        import collections
        return 1 if flag else 0

    class Local:
        def local_method(self, items):
            for item in items:
                assert item

    return nested


class Example:
    def method(self, xs):
        if xs and len(xs) > 1 or False:
            for x in xs:
                while x:
                    x -= 1
                else:
                    continue
        elif not xs:
            pass

        try:
            assert xs
        except ValueError:
            raise
        except Exception:
            pass
        finally:
            with resource():
                pass

        match xs:
            case []:
                pass
            case [x] if x > 0:
                pass
            case _:
                pass

        choice = 1 if xs else 0
        data = [x for x in xs if x if x > 1]
        generated = (a for a in xs for b in xs if b)
        ignored = lambda y: 1 if y else 0

        def inner(flag):
            if flag:
                return 1
            return 0

        return choice

    async def async_method(self, items):
        async for item in items:
            if item:
                await consume(item)
        return None


async def top_async(flag):
    try:
        await do_work()
    except* RuntimeError:
        pass
    return flag and ready and enabled


def set_builder(values):
    return {value for value in values if value}


def generator():
    yield 1
