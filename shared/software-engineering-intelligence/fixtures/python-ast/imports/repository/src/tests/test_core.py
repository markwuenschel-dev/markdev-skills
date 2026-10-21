from acme import core


def test_choose():
    assert core.choose([1], True) == [1]
