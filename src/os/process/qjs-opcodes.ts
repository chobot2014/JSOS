/**
 * qjs-opcodes.ts — QuickJS VM Bytecode Opcode Definitions
 *
 * Verified against the JSOS QuickJS build (2021.03.27 base, Step-5 patched).
 * Sources: quickjs-opcode.h — each opcode is the index in the DEF() table.
 *
 * Opcode encoding reminder:
 *   byte[0]  = opcode
 *   byte[1…] = zero or more arguments, widths given by OPCODE_SIZE (includes opcode byte)
 *
 * OPCODE_STACK_EFFECT: net change to the JS value stack (- = pops, + = pushes).
 * Undefined in OPCODE_STACK_EFFECT means the effect is variable or jump-dependent.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Opcode constants
// ─────────────────────────────────────────────────────────────────────────────

export const OP_invalid           = 0x00;

// Literal pushes
export const OP_push_i32          = 0x01;  // 5 bytes: i32  → +1
export const OP_push_const        = 0x02;  // 5 bytes: u32 cpool index → +1
export const OP_fclosure          = 0x03;  // 5 bytes: u32 cpool index → +1
export const OP_push_atom_value   = 0x04;  // 5 bytes: u32 atom → +1
export const OP_private_symbol    = 0x05;  // 5 bytes: u32 atom → +1
export const OP_undefined         = 0x06;  // 1 byte  → +1
export const OP_null              = 0x07;  // 1 byte  → +1
export const OP_push_this         = 0x08;  // 1 byte  → +1
export const OP_push_false        = 0x09;  // 1 byte  → +1
export const OP_push_true         = 0x0A;  // 1 byte  → +1
export const OP_object            = 0x0B;  // 1 byte  → +1
export const OP_special_object    = 0x0C;  // 2 bytes: u8 kind → +1
export const OP_rest              = 0x0D;  // 3 bytes: u16 first_idx → +1

// Stack manipulation
export const OP_drop              = 0x0E;  // 1 byte  → -1
export const OP_nip               = 0x0F;  // 1 byte  → -1 (remove TOS-1, keep TOS)
export const OP_nip1              = 0x10;  // 1 byte  → -1
export const OP_dup               = 0x11;  // 1 byte  → +1
export const OP_dup2              = 0x12;  // 1 byte  → +2
export const OP_dup3              = 0x13;  // 1 byte  → +3
export const OP_dup1              = 0x14;  // 1 byte  → +1
export const OP_insert2           = 0x15;  // 1 byte  → +1 (insert under 2)
export const OP_insert3           = 0x16;  // 1 byte  → +1
export const OP_insert4           = 0x17;  // 1 byte  → +1
export const OP_perm3             = 0x18;  // 1 byte  →  0
export const OP_perm4             = 0x19;  // 1 byte  →  0
export const OP_perm5             = 0x1A;  // 1 byte  →  0
export const OP_swap              = 0x1B;  // 1 byte  →  0
export const OP_swap2             = 0x1C;  // 1 byte  →  0
export const OP_rot3l             = 0x1D;  // 1 byte  →  0
export const OP_rot3r             = 0x1E;  // 1 byte  →  0
export const OP_rot4l             = 0x1F;  // 1 byte  →  0
export const OP_rot5l             = 0x20;  // 1 byte  →  0

// Variable access — local slots (index as u16)
export const OP_get_loc           = 0x21;  // 3 bytes: u16 idx → +1
export const OP_put_loc           = 0x22;  // 3 bytes: u16 idx → -1
export const OP_set_loc           = 0x23;  // 3 bytes: u16 idx →  0 (assign, keep TOS)
export const OP_get_arg           = 0x24;  // 3 bytes: u16 idx → +1
export const OP_put_arg           = 0x25;  // 3 bytes: u16 idx → -1
export const OP_set_arg           = 0x26;  // 3 bytes: u16 idx →  0
export const OP_get_var_ref       = 0x27;  // 3 bytes: u16 idx → +1
export const OP_put_var_ref       = 0x28;  // 3 bytes: u16 idx → -1
export const OP_set_var_ref       = 0x29;  // 3 bytes: u16 idx →  0
export const OP_get_ref_value     = 0x2A;  // 1 byte  → -1 +1 (deref closure cell)
export const OP_put_ref_value     = 0x2B;  // 1 byte  → -2 (store + drop ref)

// Short local-slot aliases (0..5 without encoding overhead)
export const OP_get_loc0          = 0x2C;  // 1 byte  → +1
export const OP_get_loc1          = 0x2D;  // 1 byte  → +1
export const OP_get_loc2          = 0x2E;  // 1 byte  → +1
export const OP_get_loc3          = 0x2F;  // 1 byte  → +1
export const OP_put_loc0          = 0x30;  // 1 byte  → -1
export const OP_put_loc1          = 0x31;  // 1 byte  → -1
export const OP_put_loc2          = 0x32;  // 1 byte  → -1
export const OP_put_loc3          = 0x33;  // 1 byte  → -1
export const OP_set_loc0          = 0x34;  // 1 byte  →  0
export const OP_set_loc1          = 0x35;  // 1 byte  →  0
export const OP_set_loc2          = 0x36;  // 1 byte  →  0
export const OP_set_loc3          = 0x37;  // 1 byte  →  0

// Global variables (atom)
export const OP_get_global_var    = 0x38;  // 6 bytes: u32 atom, u8 flags → +1
export const OP_put_global_var    = 0x39;  // 6 bytes: u32 atom, u8 flags → -1
export const OP_get_var           = 0x3A;  // 5 bytes: u32 atom → +1
export const OP_put_var           = 0x3B;  // 5 bytes: u32 atom → -1

// Control flow
export const OP_return_val        = 0x3C;  // 1 byte  → returns TOS to caller
export const OP_return_undef      = 0x3D;  // 1 byte  → returns undefined
export const OP_check_ctor_return = 0x3E;  // 1 byte  → -1 +1
export const OP_check_ctor        = 0x3F;  // 1 byte  → 0
export const OP_check_brand       = 0x40;  // 1 byte  → 0
export const OP_add_brand         = 0x41;  // 1 byte  → -2

// Function call
export const OP_call0             = 0x42;  // 3 bytes: u16 arg_count → net -(n+1)+1
export const OP_call              = 0x43;  // 3 bytes: u16 arg_count → net -(n+1)+1
export const OP_call_constructor  = 0x44;  // 3 bytes: u16 arg_count
export const OP_call_method       = 0x45;  // 3 bytes: u16 arg_count
export const OP_call_method_call  = 0x46;  // 3 bytes: u16 arg_count
export const OP_array_from        = 0x47;  // 3 bytes: u16 count → -(n)+1
export const OP_apply             = 0x48;  // 2 bytes: u8 magic → -3+1
export const OP_return_async      = 0x49;  // 1 byte
export const OP_throw             = 0x4A;  // 1 byte  → -1
export const OP_throw_error       = 0x4B;  // 6 bytes: u32 atom, u8 type → 0

// Branches and jumps (all 32-bit signed PC-relative offsets)
export const OP_goto              = 0x4C;  // 5 bytes: i32 offset
export const OP_goto8             = 0x4D;  // 2 bytes: i8 offset
export const OP_goto16            = 0x4E;  // 3 bytes: i16 offset
export const OP_if_true           = 0x4F;  // 5 bytes: i32 → -1
export const OP_if_false          = 0x50;  // 5 bytes: i32 → -1
export const OP_if_true8          = 0x51;  // 2 bytes: i8 → -1
export const OP_if_false8         = 0x52;  // 2 bytes: i8 → -1

// Arithmetic (binary, operate on TOS and TOS-1)
export const OP_add               = 0x53;  // 1 byte  → -1
export const OP_add_loc           = 0x54;  // 3 bytes: u16 local_idx → 0 (local += TOS; pop)
export const OP_add_loc8          = 0x55;  // 2 bytes: u8 local_idx  → 0
export const OP_sub               = 0x56;  // 1 byte  → -1
export const OP_mul               = 0x57;  // 1 byte  → -1
export const OP_div               = 0x58;  // 1 byte  → -1
export const OP_mod               = 0x59;  // 1 byte  → -1
export const OP_pow               = 0x5A;  // 1 byte  → -1

// Bitwise
export const OP_or                = 0x5B;  // 1 byte  → -1
export const OP_and               = 0x5C;  // 1 byte  → -1
export const OP_xor               = 0x5D;  // 1 byte  → -1
export const OP_shl               = 0x5E;  // 1 byte  → -1
export const OP_sar               = 0x5F;  // 1 byte  → -1
export const OP_shr               = 0x60;  // 1 byte  → -1

// Unary
export const OP_neg               = 0x61;  // 1 byte  →  0
export const OP_plus              = 0x62;  // 1 byte  →  0
export const OP_not               = 0x63;  // 1 byte  →  0 (bitwise NOT)
export const OP_lnot              = 0x64;  // 1 byte  →  0 (logical NOT)
export const OP_typeof            = 0x65;  // 1 byte  →  0

// Comparison
export const OP_eq                = 0x66;  // 1 byte  → -1 (==)
export const OP_neq               = 0x67;  // 1 byte  → -1 (!=)
export const OP_strict_eq         = 0x68;  // 1 byte  → -1 (===)
export const OP_strict_neq        = 0x69;  // 1 byte  → -1 (!==)
export const OP_lt                = 0x6A;  // 1 byte  → -1 (<)
export const OP_lte               = 0x6B;  // 1 byte  → -1 (<=)
export const OP_gt                = 0x6C;  // 1 byte  → -1 (>)
export const OP_gte               = 0x6D;  // 1 byte  → -1 (>=)
export const OP_instanceof        = 0x6E;  // 1 byte  → -1
export const OP_in                = 0x6F;  // 1 byte  → -1

// Increment/decrement (in-place — modifies local without push/pop round-trip)
export const OP_inc_loc           = 0x70;  // 3 bytes: u16 idx →  0
export const OP_dec_loc           = 0x71;  // 3 bytes: u16 idx →  0
export const OP_inc_loc8          = 0x72;  // 2 bytes: u8  idx →  0
export const OP_dec_loc8          = 0x73;  // 2 bytes: u8  idx →  0
export const OP_post_inc           = 0x74;  // 1 byte  →  0 (TOS +=1, push old)
export const OP_post_dec           = 0x75;  // 1 byte  →  0

// Property access
export const OP_get_field         = 0x76;  // 5 bytes: u32 atom → 0+1-1 = 0 (replace obj with prop)
export const OP_get_field2        = 0x77;  // 5 bytes: u32 atom → +1 (keep obj, push prop)
export const OP_put_field         = 0x78;  // 5 bytes: u32 atom → -2
export const OP_get_private_field = 0x79;  // 1 byte  → -1
export const OP_put_private_field = 0x7A;  // 1 byte  → -3
export const OP_define_private_field = 0x7B;  // 1 byte  → -2
export const OP_get_array_el      = 0x7C;  // 1 byte  → -1 (a[i] → val)
export const OP_get_array_el2     = 0x7D;  // 1 byte  → 0  (keep obj+idx, push val)
export const OP_get_super_value   = 0x7E;  // 1 byte  → -1
export const OP_put_array_el      = 0x7F;  // 1 byte  → -2 (a[i]=v)
export const OP_put_super_value   = 0x80;  // 1 byte  → -3
export const OP_define_array_el   = 0x81;  // 1 byte  → -2
export const OP_append            = 0x82;  // 1 byte  → -1 (array.push)
export const OP_copy_data_properties = 0x83;  // 2 bytes: u8 mask → variable
export const OP_define_method     = 0x84;  // 6 bytes: u32 atom, u8 flags → -1
export const OP_define_method_computed = 0x85;  // 2 bytes: u8 flags → -1
export const OP_define_field      = 0x86;  // 5 bytes: u32 atom → -1
export const OP_set_name          = 0x87;  // 5 bytes: u32 atom →  0
export const OP_set_name_computed = 0x88;  // 1 byte  → -1
export const OP_set_proto         = 0x89;  // 1 byte  → -1
export const OP_set_home_object   = 0x8A;  // 1 byte  → 0
export const OP_define_var        = 0x8B;  // 6 bytes: u32 atom, u8 flags → 0
export const OP_set_loc_uninitialized = 0x8C;  // 3 bytes: u16 idx → 0

// Exception handling and iteration
export const OP_push_catch_offset = 0x8D;  // 5 bytes: i32 offset → +1
export const OP_pop_catch         = 0x8E;  // 1 byte  → -1
export const OP_if_exception_is   = 0x8F;  // 5 bytes: u32 atom → -1,+1 or jump
export const OP_iterator_from_object = 0x90;  // 1 byte → 0
export const OP_for_in_start      = 0x91;  // 1 byte  → 0
export const OP_for_in_next       = 0x92;  // 1 byte  → +2 (key, done)
export const OP_iterator_next     = 0x93;  // 1 byte  → variable
export const OP_iterator_call     = 0x94;  // 2 bytes: u8 flags → variable
export const OP_iterator_check_object = 0x95;  // 1 byte → 0
export const OP_iterator_get_value_done = 0x96;  // 1 byte → +1
export const OP_iterator_close    = 0x97;  // 1 byte  → -2
export const OP_iterator_close_return = 0x98;  // 1 byte
export const OP_destructuring_exception = 0x99;  // 1 byte → +1
export const OP_exception         = 0x9A;  // 1 byte  → +1 (push caught exception)
export const OP_ret               = 0x9B;  // 1 byte  (internal)
export const OP_nop               = 0x9C;  // 1 byte  →  0

// Closures and generators
export const OP_label             = 0x9D;  // 5 bytes: u32 label (pseudo-op, no runtime effect)
export const OP_make_loc_ref      = 0x9E;  // 5 bytes: u32 atom, u16 idx → +1
export const OP_make_arg_ref      = 0x9F;  // 5 bytes: u32 atom, u16 idx → +1
export const OP_make_var_ref_ref  = 0xA0;  // 5 bytes: u32 atom, u16 idx → +1
export const OP_make_var_ref      = 0xA1;  // 5 bytes: u32 atom → +1
export const OP_get_global_ref    = 0xA2;  // 5 bytes: u32 atom → +2
export const OP_get_sym_in_var    = 0xA3;  // 3 bytes: u16 idx → +1
export const OP_get_super         = 0xA4;  // 1 byte  → +1
export const OP_to_object         = 0xA5;  // 1 byte  →  0
export const OP_to_array          = 0xA6;  // 1 byte  → +1? (spread)
export const OP_with_get_var      = 0xA7;  // 6 bytes: u32 atom, u8 is_with → +1
export const OP_with_put_var      = 0xA8;  // 6 bytes: u32 atom, u8 is_with → -1
export const OP_with_delete_var   = 0xA9;  // 6 bytes: u32 atom, u8 is_with → +1
export const OP_with_make_ref     = 0xAA;  // 6 bytes: u32 atom, u8 is_with → +1
export const OP_with_get_ref      = 0xAB;  // 6 bytes: u32 atom, u8 is_with → +1
export const OP_with_get_ref2     = 0xAC;  // 6 bytes: u32 atom, u8 is_with → +2
export const OP_get_scope_obj     = 0xAD;  // 2 bytes: u8 scope → +1

// Async / Generator
export const OP_initial_yield     = 0xAE;  // 1 byte
export const OP_yield             = 0xAF;  // 1 byte  → -1+1 (yield, resume)
export const OP_yield_star        = 0xB0;  // 1 byte  → -1+1
export const OP_async_yield_star  = 0xB1;  // 1 byte
export const OP_await             = 0xB2;  // 1 byte  → -1+1

// Misc
export const OP_spread            = 0xB3;  // 2 bytes: u8 flags → -1,+(n)
export const OP_symbol_for        = 0xB4;  // 5 bytes: u32 atom → 0
export const OP_typeof_is_undefined = 0xB5;  // 5 bytes: u32 atom → +1
export const OP_typeof_is_function  = 0xB6;  // 5 bytes: u32 atom → +1

// ─────────────────────────────────────────────────────────────────────────────
//  OPCODE_SIZE: total byte width of each instruction (opcode + args)
//  undefined = variable / not directly JIT-compiled
// ─────────────────────────────────────────────────────────────────────────────
export const OPCODE_SIZE: Record<number, number> = {
  [OP_invalid]:           1,
  [OP_push_i32]:          5,
  [OP_push_const]:        5,
  [OP_fclosure]:          5,
  [OP_push_atom_value]:   5,
  [OP_private_symbol]:    5,
  [OP_undefined]:         1,
  [OP_null]:              1,
  [OP_push_this]:         1,
  [OP_push_false]:        1,
  [OP_push_true]:         1,
  [OP_object]:            1,
  [OP_special_object]:    2,
  [OP_rest]:              3,
  [OP_drop]:              1,
  [OP_nip]:               1,
  [OP_nip1]:              1,
  [OP_dup]:               1,
  [OP_dup2]:              1,
  [OP_dup3]:              1,
  [OP_dup1]:              1,
  [OP_insert2]:           1,
  [OP_insert3]:           1,
  [OP_insert4]:           1,
  [OP_perm3]:             1,
  [OP_perm4]:             1,
  [OP_perm5]:             1,
  [OP_swap]:              1,
  [OP_swap2]:             1,
  [OP_rot3l]:             1,
  [OP_rot3r]:             1,
  [OP_rot4l]:             1,
  [OP_rot5l]:             1,
  [OP_get_loc]:           3,
  [OP_put_loc]:           3,
  [OP_set_loc]:           3,
  [OP_get_arg]:           3,
  [OP_put_arg]:           3,
  [OP_set_arg]:           3,
  [OP_get_var_ref]:       3,
  [OP_put_var_ref]:       3,
  [OP_set_var_ref]:       3,
  [OP_get_ref_value]:     1,
  [OP_put_ref_value]:     1,
  [OP_get_loc0]:          1,
  [OP_get_loc1]:          1,
  [OP_get_loc2]:          1,
  [OP_get_loc3]:          1,
  [OP_put_loc0]:          1,
  [OP_put_loc1]:          1,
  [OP_put_loc2]:          1,
  [OP_put_loc3]:          1,
  [OP_set_loc0]:          1,
  [OP_set_loc1]:          1,
  [OP_set_loc2]:          1,
  [OP_set_loc3]:          1,
  [OP_get_global_var]:    6,
  [OP_put_global_var]:    6,
  [OP_get_var]:           5,
  [OP_put_var]:           5,
  [OP_return_val]:        1,
  [OP_return_undef]:      1,
  [OP_check_ctor_return]: 1,
  [OP_check_ctor]:        1,
  [OP_check_brand]:       1,
  [OP_add_brand]:         1,
  [OP_call0]:             3,
  [OP_call]:              3,
  [OP_call_constructor]:  3,
  [OP_call_method]:       3,
  [OP_call_method_call]:  3,
  [OP_array_from]:        3,
  [OP_apply]:             2,
  [OP_return_async]:      1,
  [OP_throw]:             1,
  [OP_throw_error]:       6,
  [OP_goto]:              5,
  [OP_goto8]:             2,
  [OP_goto16]:            3,
  [OP_if_true]:           5,
  [OP_if_false]:          5,
  [OP_if_true8]:          2,
  [OP_if_false8]:         2,
  [OP_add]:               1,
  [OP_add_loc]:           3,
  [OP_add_loc8]:          2,
  [OP_sub]:               1,
  [OP_mul]:               1,
  [OP_div]:               1,
  [OP_mod]:               1,
  [OP_pow]:               1,
  [OP_or]:                1,
  [OP_and]:               1,
  [OP_xor]:               1,
  [OP_shl]:               1,
  [OP_sar]:               1,
  [OP_shr]:               1,
  [OP_neg]:               1,
  [OP_plus]:              1,
  [OP_not]:               1,
  [OP_lnot]:              1,
  [OP_typeof]:            1,
  [OP_eq]:                1,
  [OP_neq]:               1,
  [OP_strict_eq]:         1,
  [OP_strict_neq]:        1,
  [OP_lt]:                1,
  [OP_lte]:               1,
  [OP_gt]:                1,
  [OP_gte]:               1,
  [OP_instanceof]:        1,
  [OP_in]:                1,
  [OP_inc_loc]:           3,
  [OP_dec_loc]:           3,
  [OP_inc_loc8]:          2,
  [OP_dec_loc8]:          2,
  [OP_post_inc]:          1,
  [OP_post_dec]:          1,
  [OP_get_field]:         5,
  [OP_get_field2]:        5,
  [OP_put_field]:         5,
  [OP_get_private_field]: 1,
  [OP_put_private_field]: 1,
  [OP_define_private_field]: 1,
  [OP_get_array_el]:      1,
  [OP_get_array_el2]:     1,
  [OP_get_super_value]:   1,
  [OP_put_array_el]:      1,
  [OP_put_super_value]:   1,
  [OP_define_array_el]:   1,
  [OP_append]:            1,
  [OP_copy_data_properties]: 2,
  [OP_define_method]:     6,
  [OP_define_method_computed]: 2,
  [OP_define_field]:      5,
  [OP_set_name]:          5,
  [OP_set_name_computed]: 1,
  [OP_set_proto]:         1,
  [OP_set_home_object]:   1,
  [OP_define_var]:        6,
  [OP_set_loc_uninitialized]: 3,
  [OP_push_catch_offset]: 5,
  [OP_pop_catch]:         1,
  [OP_if_exception_is]:   5,
  [OP_iterator_from_object]: 1,
  [OP_for_in_start]:      1,
  [OP_for_in_next]:       1,
  [OP_iterator_next]:     1,
  [OP_iterator_call]:     2,
  [OP_iterator_check_object]: 1,
  [OP_iterator_get_value_done]: 1,
  [OP_iterator_close]:    1,
  [OP_iterator_close_return]: 1,
  [OP_destructuring_exception]: 1,
  [OP_exception]:         1,
  [OP_ret]:               1,
  [OP_nop]:               1,
  [OP_label]:             5,
  [OP_make_loc_ref]:      5,
  [OP_make_arg_ref]:      5,
  [OP_make_var_ref_ref]:  5,
  [OP_make_var_ref]:      5,
  [OP_get_global_ref]:    5,
  [OP_get_sym_in_var]:    3,
  [OP_get_super]:         1,
  [OP_to_object]:         1,
  [OP_to_array]:          1,
  [OP_with_get_var]:      6,
  [OP_with_put_var]:      6,
  [OP_with_delete_var]:   6,
  [OP_with_make_ref]:     6,
  [OP_with_get_ref]:      6,
  [OP_with_get_ref2]:     6,
  [OP_get_scope_obj]:     2,
  [OP_initial_yield]:     1,
  [OP_yield]:             1,
  [OP_yield_star]:        1,
  [OP_async_yield_star]:  1,
  [OP_await]:             1,
  [OP_spread]:            2,
  [OP_symbol_for]:        5,
  [OP_typeof_is_undefined]: 5,
  [OP_typeof_is_function]:  5,
};

// ─────────────────────────────────────────────────────────────────────────────
//  OPCODE_STACK_EFFECT: net stack delta.  undefined = dynamic / not JIT-able.
// ─────────────────────────────────────────────────────────────────────────────
export const OPCODE_STACK_EFFECT: Record<number, number | undefined> = {
  [OP_invalid]:              0,
  [OP_push_i32]:            +1,
  [OP_push_const]:          +1,
  [OP_fclosure]:            +1,
  [OP_push_atom_value]:     +1,
  [OP_private_symbol]:      +1,
  [OP_undefined]:           +1,
  [OP_null]:                +1,
  [OP_push_this]:           +1,
  [OP_push_false]:          +1,
  [OP_push_true]:           +1,
  [OP_object]:              +1,
  [OP_special_object]:      +1,
  [OP_rest]:                +1,
  [OP_drop]:                -1,
  [OP_nip]:                 -1,
  [OP_nip1]:                -1,
  [OP_dup]:                 +1,
  [OP_dup2]:                +2,
  [OP_dup3]:                +3,
  [OP_dup1]:                +1,
  [OP_insert2]:             +1,
  [OP_insert3]:             +1,
  [OP_insert4]:             +1,
  [OP_perm3]:                0,
  [OP_perm4]:                0,
  [OP_perm5]:                0,
  [OP_swap]:                 0,
  [OP_swap2]:                0,
  [OP_rot3l]:                0,
  [OP_rot3r]:                0,
  [OP_rot4l]:                0,
  [OP_rot5l]:                0,
  [OP_get_loc]:             +1,
  [OP_put_loc]:             -1,
  [OP_set_loc]:              0,
  [OP_get_arg]:             +1,
  [OP_put_arg]:             -1,
  [OP_set_arg]:              0,
  [OP_get_var_ref]:         +1,
  [OP_put_var_ref]:         -1,
  [OP_set_var_ref]:          0,
  [OP_get_ref_value]:        0,  // -1 ref +1 val
  [OP_put_ref_value]:       -2,
  [OP_get_loc0]:            +1,
  [OP_get_loc1]:            +1,
  [OP_get_loc2]:            +1,
  [OP_get_loc3]:            +1,
  [OP_put_loc0]:            -1,
  [OP_put_loc1]:            -1,
  [OP_put_loc2]:            -1,
  [OP_put_loc3]:            -1,
  [OP_set_loc0]:             0,
  [OP_set_loc1]:             0,
  [OP_set_loc2]:             0,
  [OP_set_loc3]:             0,
  [OP_get_global_var]:      +1,
  [OP_put_global_var]:      -1,
  [OP_get_var]:             +1,
  [OP_put_var]:             -1,
  [OP_return_val]:          -1,
  [OP_return_undef]:         0,
  [OP_check_ctor_return]:    0,
  [OP_check_ctor]:           0,
  [OP_check_brand]:          0,
  [OP_add_brand]:           -2,
  [OP_call0]:               undefined,  // depends on arg count
  [OP_call]:                undefined,
  [OP_call_constructor]:    undefined,
  [OP_call_method]:         undefined,
  [OP_call_method_call]:    undefined,
  [OP_array_from]:          undefined,
  [OP_apply]:               -3+1,
  [OP_return_async]:         0,
  [OP_throw]:               -1,
  [OP_throw_error]:          0,
  [OP_goto]:                 0,
  [OP_goto8]:                0,
  [OP_goto16]:               0,
  [OP_if_true]:             -1,
  [OP_if_false]:            -1,
  [OP_if_true8]:            -1,
  [OP_if_false8]:           -1,
  [OP_add]:                 -1,
  [OP_add_loc]:              0,
  [OP_add_loc8]:             0,
  [OP_sub]:                 -1,
  [OP_mul]:                 -1,
  [OP_div]:                 -1,
  [OP_mod]:                 -1,
  [OP_pow]:                 -1,
  [OP_or]:                  -1,
  [OP_and]:                 -1,
  [OP_xor]:                 -1,
  [OP_shl]:                 -1,
  [OP_sar]:                 -1,
  [OP_shr]:                 -1,
  [OP_neg]:                  0,
  [OP_plus]:                 0,
  [OP_not]:                  0,
  [OP_lnot]:                 0,
  [OP_typeof]:               0,
  [OP_eq]:                  -1,
  [OP_neq]:                 -1,
  [OP_strict_eq]:           -1,
  [OP_strict_neq]:          -1,
  [OP_lt]:                  -1,
  [OP_lte]:                 -1,
  [OP_gt]:                  -1,
  [OP_gte]:                 -1,
  [OP_instanceof]:          -1,
  [OP_in]:                  -1,
  [OP_inc_loc]:              0,
  [OP_dec_loc]:              0,
  [OP_inc_loc8]:             0,
  [OP_dec_loc8]:             0,
  [OP_post_inc]:            +1,
  [OP_post_dec]:            +1,
  [OP_get_field]:            0,
  [OP_get_field2]:          +1,
  [OP_put_field]:           -2,
  [OP_get_private_field]:   -1,
  [OP_put_private_field]:   -3,
  [OP_define_private_field]:-2,
  [OP_get_array_el]:        -1,
  [OP_get_array_el2]:        0,
  [OP_get_super_value]:     -1,
  [OP_put_array_el]:        -2,
  [OP_put_super_value]:     -3,
  [OP_define_array_el]:     -2,
  [OP_append]:              -1,
  [OP_copy_data_properties]: undefined,
  [OP_define_method]:       -1,
  [OP_define_method_computed]: -1,
  [OP_define_field]:        -1,
  [OP_set_name]:             0,
  [OP_set_name_computed]:   -1,
  [OP_set_proto]:           -1,
  [OP_set_home_object]:      0,
  [OP_define_var]:           0,
  [OP_set_loc_uninitialized]: 0,
  [OP_push_catch_offset]:   +1,
  [OP_pop_catch]:           -1,
  [OP_if_exception_is]:     undefined,
  [OP_iterator_from_object]: 0,
  [OP_for_in_start]:         0,
  [OP_for_in_next]:         +2,
  [OP_iterator_next]:       undefined,
  [OP_iterator_call]:       undefined,
  [OP_iterator_check_object]: 0,
  [OP_iterator_get_value_done]: +1,
  [OP_iterator_close]:      -2,
  [OP_iterator_close_return]: 0,
  [OP_destructuring_exception]: +1,
  [OP_exception]:           +1,
  [OP_ret]:                  0,
  [OP_nop]:                  0,
  [OP_label]:                0,
  [OP_make_loc_ref]:        +1,
  [OP_make_arg_ref]:        +1,
  [OP_make_var_ref_ref]:    +1,
  [OP_make_var_ref]:        +1,
  [OP_get_global_ref]:      +2,
  [OP_get_sym_in_var]:      +1,
  [OP_get_super]:           +1,
  [OP_to_object]:            0,
  [OP_to_array]:             0,
  [OP_with_get_var]:        +1,
  [OP_with_put_var]:        -1,
  [OP_with_delete_var]:     +1,
  [OP_with_make_ref]:       +1,
  [OP_with_get_ref]:        +1,
  [OP_with_get_ref2]:       +2,
  [OP_get_scope_obj]:       +1,
  [OP_initial_yield]:        0,
  [OP_yield]:               undefined,
  [OP_yield_star]:          undefined,
  [OP_async_yield_star]:    undefined,
  [OP_await]:               undefined,
  [OP_spread]:              undefined,
  [OP_symbol_for]:           0,
  [OP_typeof_is_undefined]: +1,
  [OP_typeof_is_function]:  +1,
};

/**
 * Identify the set of opcodes that the Priority-1 JIT compiler handles.
 * Any opcode NOT in this set causes the compiler to bail out (deopt).
 */
export const JIT_SUPPORTED_OPCODES = new Set<number>([
  OP_push_i32,
  OP_push_const,   // integer constants from the constant pool (non-int values bail in compile())
  OP_push_false, OP_push_true, OP_null, OP_undefined,
  OP_get_loc, OP_put_loc, OP_set_loc,
  OP_get_loc0, OP_get_loc1, OP_get_loc2, OP_get_loc3,
  OP_put_loc0, OP_put_loc1, OP_put_loc2, OP_put_loc3,
  OP_set_loc0, OP_set_loc1, OP_set_loc2, OP_set_loc3,
  OP_get_arg, OP_put_arg, OP_set_arg,
  OP_add, OP_sub, OP_mul, OP_div, OP_mod,
  OP_neg, OP_plus, OP_not, OP_lnot,
  OP_eq, OP_neq, OP_strict_eq, OP_strict_neq,
  OP_lt, OP_lte, OP_gt, OP_gte,
  OP_or, OP_and, OP_xor, OP_shl, OP_sar, OP_shr,
  OP_inc_loc, OP_dec_loc, OP_inc_loc8, OP_dec_loc8,
  OP_add_loc, OP_add_loc8,
  // Stack manipulation — extended set
  OP_drop, OP_dup, OP_dup1, OP_dup2, OP_dup3, OP_nip, OP_nip1, OP_swap,
  OP_rot3l, OP_rot3r,
  // Post-increment / decrement (common in for-loops)
  OP_post_inc, OP_post_dec,
  OP_if_true8, OP_if_false8, OP_if_true, OP_if_false,
  OP_goto, OP_goto8, OP_goto16,
  OP_return_val, OP_return_undef,
  OP_nop,
  OP_label,        // pseudo-op — no runtime effect, just advances PC
]);
