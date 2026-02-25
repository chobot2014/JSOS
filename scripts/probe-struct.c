#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include "quickjs.h"

/* QuickJS hides JSFunctionBytecode and JSObject in quickjs.c, not quickjs.h.
   We need to include quickjs.c partially or use JS_VALUE_GET_TAG etc.
   For now, let's check what's visible from quickjs.h and measure JSValue. */

int main(void) {
    printf("=== JSValue layout ===\n");
    printf("sizeof(JSValue) = %zu\n", sizeof(JSValue));
    printf("sizeof(JSValueUnion) = %zu\n", sizeof(JSValueUnion));

    /* Check tag values */
    printf("\n=== Tag constants ===\n");
    printf("JS_TAG_INT = %d\n", JS_TAG_INT);
    printf("JS_TAG_BOOL = %d\n", JS_TAG_BOOL);
    printf("JS_TAG_NULL = %d\n", JS_TAG_NULL);
    printf("JS_TAG_UNDEFINED = %d\n", JS_TAG_UNDEFINED);
    printf("JS_TAG_UNINITIALIZED = %d\n", JS_TAG_UNINITIALIZED);
    printf("JS_TAG_OBJECT = %d\n", JS_TAG_OBJECT);
    printf("JS_TAG_STRING = %d\n", JS_TAG_STRING);
    printf("JS_TAG_SYMBOL = %d\n", JS_TAG_SYMBOL);
    printf("JS_TAG_FLOAT64 = %d\n", JS_TAG_FLOAT64);
    printf("JS_TAG_EXCEPTION = %d\n", JS_TAG_EXCEPTION);
    printf("JS_TAG_FIRST = %d\n", JS_TAG_FIRST);

    /* Check JSValue field offsets */
    JSValue v;
    printf("\n=== JSValue field offsets ===\n");
    printf("offset of u = %zu\n", (size_t)((char*)&v.u - (char*)&v));
    printf("offset of tag = %zu\n", (size_t)((char*)&v.tag - (char*)&v));
    printf("sizeof(v.tag) = %zu\n", sizeof(v.tag));

    /* Check if JS_NAN_BOXING is defined */
#ifdef JS_NAN_BOXING
    printf("\nJS_NAN_BOXING = DEFINED\n");
#else
    printf("\nJS_NAN_BOXING = NOT defined\n");
#endif

#ifdef CONFIG_BIGNUM
    printf("CONFIG_BIGNUM = DEFINED\n");
#else
    printf("CONFIG_BIGNUM = NOT defined\n");
#endif

    return 0;
}
