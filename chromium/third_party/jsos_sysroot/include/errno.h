/* JSOS sysroot — errno.h
 * Maps to Phase 6 POSIX errno constants embedded in JSOS syscalls.ts.
 */
#ifndef _JSOS_ERRNO_H
#define _JSOS_ERRNO_H

#ifdef __cplusplus
extern "C" {
#endif

extern int *__jsos_errno_location(void);
#define errno (*__jsos_errno_location())

#define EPERM          1   /* Operation not permitted          */
#define ENOENT         2   /* No such file or directory        */
#define ESRCH          3   /* No such process                  */
#define EINTR          4   /* Interrupted system call          */
#define EIO            5   /* I/O error                        */
#define ENXIO          6   /* No such device or address        */
#define E2BIG          7   /* Argument list too long           */
#define ENOEXEC        8   /* Exec format error                */
#define EBADF          9   /* Bad file number                  */
#define ECHILD        10   /* No child processes               */
#define EAGAIN        11   /* Try again                        */
#define ENOMEM        12   /* Out of memory                    */
#define EACCES        13   /* Permission denied                */
#define EFAULT        14   /* Bad address                      */
#define EBUSY         16   /* Device or resource busy          */
#define EEXIST        17   /* File exists                      */
#define ENODEV        19   /* No such device                   */
#define ENOTDIR       20   /* Not a directory                  */
#define EISDIR        21   /* Is a directory                   */
#define EINVAL        22   /* Invalid argument                 */
#define ENFILE        23   /* File table overflow              */
#define EMFILE        24   /* Too many open files              */
#define ENOTTY        25   /* Not a typewriter                 */
#define EFBIG         27   /* File too large                   */
#define ENOSPC        28   /* No space left on device          */
#define ESPIPE        29   /* Illegal seek                     */
#define EROFS         30   /* Read-only file system            */
#define EPIPE         32   /* Broken pipe                      */
#define EDOM          33   /* Math argument out of domain      */
#define ERANGE        34   /* Math result not representable    */
#define EDEADLK       35   /* Resource deadlock would occur    */
#define ENAMETOOLONG  36   /* File name too long               */
#define ENOLCK        37   /* No record locks available        */
#define ENOSYS        38   /* Function not implemented         */
#define ENOTEMPTY     39   /* Directory not empty              */
#define ELOOP         40   /* Too many symbolic links          */
#define EWOULDBLOCK   EAGAIN
#define ENOMSG        42   /* No message of desired type       */
#define EIDRM         43   /* Identifier removed               */
#define ENOTSUP       95   /* Operation not supported          */
#define ENOTSOCK      88   /* Socket operation on non-socket   */
#define EADDRINUSE    98   /* Address already in use           */
#define ECONNRESET   104   /* Connection reset by peer         */
#define ETIMEDOUT    110   /* Connection timed out             */
#define ECONNREFUSED 111   /* Connection refused               */

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_ERRNO_H */
