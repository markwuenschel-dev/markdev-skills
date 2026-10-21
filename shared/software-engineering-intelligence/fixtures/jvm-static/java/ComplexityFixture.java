package example.jvm;

import java.util.List;
import static java.util.Collections.emptyList;

final class ComplexityFixture {
    static {
        if (enabled()) boot();
    }

    {
        for (int index = 0; index < 1; index++) boot();
    }

    ComplexityFixture(int seed) {
        if (seed < 0) throw new IllegalArgumentException();
    }

    int score(List<String> values) {
        int total = 0;
        for (String value : values) {
            if (value != null && !value.isEmpty()) total++;
        }
        switch (total) {
            case 0 -> total = 1;
            case 1, 2 -> total += 2;
            default -> total += 3;
        }
        try {
            total += emptyList().size();
        } catch (RuntimeException error) {
            total--;
        }
        return total > 10 ? total : 10;
    }

    Runnable worker() {
        return () -> {
            while (enabled()) break;
        };
    }

    private static boolean enabled() {
        return true;
    }

    private static void boot() {}
}
