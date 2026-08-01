/* Compile inside quickjs.c to access internal structs */
#include <stddef.h>

/* We need JSFunctionBytecode which is defined in quickjs.c.
   Include the relevant parts by compiling as part of quickjs.c context. */

/* These will be referenced by nm to extract offsets */
const int off_byte_code_buf = __builtin_offsetof(JSFunctionBytecode, byte_code_buf);
const int off_byte_code_len = __builtin_offsetof(JSFunctionBytecode, byte_code_len);
const int off_arg_count     = __builtin_offsetof(JSFunctionBytecode, arg_count);
const int off_var_count     = __builtin_offsetof(JSFunctionBytecode, var_count);
const int off_stack_size    = __builtin_offsetof(JSFunctionBytecode, stack_size);
const int off_cpool         = __builtin_offsetof(JSFunctionBytecode, cpool);
const int off_cpool_count   = __builtin_offsetof(JSFunctionBytecode, cpool_count);
const int off_func_name     = __builtin_offsetof(JSFunctionBytecode, func_name);
const int off_defined_arg_count = __builtin_offsetof(JSFunctionBytecode, defined_arg_count);
const int off_realm         = __builtin_offsetof(JSFunctionBytecode, realm);
const int off_closure_var   = __builtin_offsetof(JSFunctionBytecode, closure_var);
const int off_vardefs       = __builtin_offsetof(JSFunctionBytecode, vardefs);
const int off_debug         = __builtin_offsetof(JSFunctionBytecode, debug);
const int sz_JSFunctionBytecode = sizeof(JSFunctionBytecode);

/* Also get JSGCObjectHeader size */
const int sz_JSGCObjectHeader = sizeof(JSGCObjectHeader);

/* JSObject layout for inline caches */
const int off_shape = __builtin_offsetof(JSObject, shape);
const int sz_JSObject = sizeof(JSObject);
