def leaf(value):
    match value:
        case 0:
            return "zero"
        case _:
            return "other"
