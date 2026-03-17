#include <stddef.h>
#include <stdint.h>

/* We include quickjs.h but JSValue might be opaque there.
   Let's check what the cross-compiler sees. */
#include "quickjs.h"

/* Output sizeof to linker symbols so we can read them from the .o file */
char sizeof_JSValue[sizeof(JSValue)];

/* Check if JSValue has NaN boxing */
#ifdef JS_NAN_BOXING
char nan_boxing_on = 1;
#else
char nan_boxing_on = 0;
#endif

/* Force the values into a data section we can read */
const int tag_int = JS_TAG_INT;
const int tag_bool = JS_TAG_BOOL;
const int tag_null = JS_TAG_NULL;
const int tag_undefined = JS_TAG_UNDEFINED;
const int tag_object = JS_TAG_OBJECT;
const int tag_string = JS_TAG_STRING;
const int tag_float64 = JS_TAG_FLOAT64;
const int tag_exception = JS_TAG_EXCEPTION;
const int tag_first = JS_TAG_FIRST;
