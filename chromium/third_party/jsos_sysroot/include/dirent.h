/* JSOS sysroot — dirent.h
 * Directory iteration backed by Phase 2 VFS readdir.
 */
#ifndef _JSOS_DIRENT_H
#define _JSOS_DIRENT_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DT_UNKNOWN  0
#define DT_FIFO     1
#define DT_CHR      2
#define DT_DIR      4
#define DT_BLK      6
#define DT_REG      8
#define DT_LNK     10
#define DT_SOCK    12
#define DT_WHT     14

#define NAME_MAX   255
#define PATH_MAX   4096

struct dirent {
    unsigned long  d_ino;
    unsigned long  d_off;
    unsigned short d_reclen;
    unsigned char  d_type;
    char           d_name[NAME_MAX + 1];
};

typedef struct {
    int   fd;
    int   pos;
    struct dirent current;
} DIR;

DIR           *opendir(const char *name);
DIR           *fdopendir(int fd);
struct dirent *readdir(DIR *dirp);
int            closedir(DIR *dirp);
void           rewinddir(DIR *dirp);
long           telldir(DIR *dirp);
void           seekdir(DIR *dirp, long loc);
int            dirfd(DIR *dirp);
int            scandir(const char *dirp, struct dirent ***namelist,
                       int (*filter)(const struct dirent *),
                       int (*compar)(const struct dirent **, const struct dirent **));
void           alphasort(const struct dirent **a, const struct dirent **b);

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_DIRENT_H */
