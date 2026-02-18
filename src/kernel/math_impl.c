// Simple math function implementations for bare metal
// These are minimal implementations to satisfy QuickJS's needs

// We provide math functions, so avoid pulling in <math.h> macros that
// might conflict. Just declare what we need.
#include <stddef.h>

// Undefine any macros that may leak from toolchain headers
#undef log2
#undef fmax
#undef fmin
#undef round
#undef lrint
#undef expm1
#undef log1p

// Constants
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#ifndef M_LN2
#define M_LN2 0.69314718055994530942
#endif
#ifndef M_LN10
#define M_LN10 2.30258509299404568402
#endif

// Basic math functions
double fabs(double x) {
    return x < 0.0 ? -x : x;
}

double floor(double x) {
    if (x >= 0.0) {
        return (double)(long)x;
    } else {
        long i = (long)x;
        return (double)(x == i ? i : i - 1);
    }
}

double ceil(double x) {
    if (x >= 0.0) {
        long i = (long)x;
        return (double)(x == i ? i : i + 1);
    } else {
        return (double)(long)x;
    }
}

double fmod(double x, double y) {
    if (y == 0.0) return 0.0;
    return x - floor(x / y) * y;
}

double pow(double base, double exp) {
    // Simple power implementation for positive integer exponents
    if (exp == 0.0) return 1.0;
    if (exp == 1.0) return base;
    if (exp < 0.0) return 1.0 / pow(base, -exp);
    
    double result = 1.0;
    int int_exp = (int)exp;
    for (int i = 0; i < int_exp; i++) {
        result *= base;
    }
    return result;
}

double sqrt(double x) {
    if (x < 0.0) return 0.0;  // Invalid input
    if (x == 0.0) return 0.0;
    
    // Newton-Raphson method
    double guess = x / 2.0;
    for (int i = 0; i < 10; i++) {
        guess = (guess + x / guess) / 2.0;
    }
    return guess;
}

double sin(double x) {
    // Taylor series approximation for sin(x)
    // sin(x) = x - x^3/3! + x^5/5! - x^7/7! + ...
    double result = x;
    double term = x;
    for (int i = 1; i < 10; i++) {
        term *= -x * x / ((2 * i) * (2 * i + 1));
        result += term;
    }
    return result;
}

double cos(double x) {
    // Taylor series approximation for cos(x)
    // cos(x) = 1 - x^2/2! + x^4/4! - x^6/6! + ...
    double result = 1.0;
    double term = 1.0;
    for (int i = 1; i < 10; i++) {
        term *= -x * x / ((2 * i - 1) * (2 * i));
        result += term;
    }
    return result;
}

double tan(double x) {
    double c = cos(x);
    return c != 0.0 ? sin(x) / c : 0.0;
}

double exp(double x) {
    // Taylor series approximation for e^x
    // e^x = 1 + x + x^2/2! + x^3/3! + ...
    double result = 1.0;
    double term = 1.0;
    for (int i = 1; i < 20; i++) {
        term *= x / i;
        result += term;
    }
    return result;
}

double log(double x) {
    if (x <= 0.0) return 0.0;  // Invalid input
    
    // Natural logarithm approximation using Newton's method
    // We want to find y such that e^y = x
    double y = 0.0;
    for (int i = 0; i < 20; i++) {
        double ey = exp(y);
        y = y - (ey - x) / ey;
    }
    return y;
}

double log10(double x) {
    return log(x) / log(10.0);
}

double atan(double x) {
    // Taylor series approximation for atan(x)
    if (fabs(x) > 1.0) {
        return (x > 0 ? M_PI/2 : -M_PI/2) - atan(1.0/x);
    }
    
    double result = x;
    double term = x;
    for (int i = 1; i < 10; i++) {
        term *= -x * x;
        result += term / (2 * i + 1);
    }
    return result;
}

double atan2(double y, double x) {
    if (x > 0) return atan(y / x);
    if (x < 0 && y >= 0) return atan(y / x) + M_PI;
    if (x < 0 && y < 0) return atan(y / x) - M_PI;
    if (x == 0 && y > 0) return M_PI / 2;
    if (x == 0 && y < 0) return -M_PI / 2;
    return 0.0; // x == 0 && y == 0
}

double asin(double x) {
    if (fabs(x) > 1.0) return 0.0;  // Invalid input
    return atan(x / sqrt(1.0 - x * x));
}

double acos(double x) {
    if (fabs(x) > 1.0) return 0.0;  // Invalid input
    return M_PI / 2 - asin(x);
}

double trunc(double x) {
    return (double)(long)x;
}

double cbrt(double x) {
    if (x == 0.0) return 0.0;
    
    // Newton-Raphson method for cube root
    double guess = x / 3.0;
    for (int i = 0; i < 10; i++) {
        guess = (2.0 * guess + x / (guess * guess)) / 3.0;
    }
    return x < 0 ? -guess : guess;
}

// Additional math functions required by QuickJS

double round(double x) {
    if (x >= 0.0) {
        return floor(x + 0.5);
    } else {
        return ceil(x - 0.5);
    }
}

long lrint(double x) {
    return (long)round(x);
}

double hypot(double x, double y) {
    // sqrt(x*x + y*y) with overflow protection
    x = fabs(x);
    y = fabs(y);
    if (x > y) {
        double t = y / x;
        return x * sqrt(1.0 + t * t);
    } else if (y > 0.0) {
        double t = x / y;
        return y * sqrt(1.0 + t * t);
    }
    return 0.0;
}

double fmax(double x, double y) {
    return x > y ? x : y;
}

double fmin(double x, double y) {
    return x < y ? x : y;
}

double cosh(double x) {
    double ex = exp(x);
    return (ex + 1.0 / ex) / 2.0;
}

double sinh(double x) {
    double ex = exp(x);
    return (ex - 1.0 / ex) / 2.0;
}

double tanh(double x) {
    if (x > 20.0) return 1.0;
    if (x < -20.0) return -1.0;
    double e2x = exp(2.0 * x);
    return (e2x - 1.0) / (e2x + 1.0);
}

double acosh(double x) {
    if (x < 1.0) return 0.0;
    return log(x + sqrt(x * x - 1.0));
}

double asinh(double x) {
    return log(x + sqrt(x * x + 1.0));
}

double atanh(double x) {
    if (fabs(x) >= 1.0) return 0.0;
    return 0.5 * log((1.0 + x) / (1.0 - x));
}

double expm1(double x) {
    // For small x, use Taylor series for better precision
    if (fabs(x) < 1e-5) {
        return x + 0.5 * x * x;
    }
    return exp(x) - 1.0;
}

double log1p(double x) {
    // For small x, use Taylor series for better precision
    if (fabs(x) < 1e-5) {
        return x - 0.5 * x * x;
    }
    return log(1.0 + x);
}

double log2(double x) {
    return log(x) / M_LN2;
}
