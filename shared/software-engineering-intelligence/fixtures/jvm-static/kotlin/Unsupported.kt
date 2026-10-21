package example.jvm

class Unsupported {
    fun score(values: List<String>): Int = values.count { it.isNotEmpty() }
}
