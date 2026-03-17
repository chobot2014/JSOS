# JSOS Deployment Guide
**Items 907-909**

## Deployment Targets

### 1. Bare Metal x86 PC (item 907)

1. Download the latest `jsos.iso`
2. Write to USB: `dd if=jsos.iso of=/dev/sdX bs=4M status=progress`
3. Boot from USB (BIOS or UEFI)
4. Run the guided installer from the REPL: `installer`

### 2. QEMU Virtual Machine (items 907-908)

```bash
# BIOS mode
qemu-system-i386 -cdrom jsos.iso -m 512M -serial stdio

# UEFI mode
qemu-system-x86_64 -bios /usr/share/ovmf/OVMF.fd \
  -cdrom jsos.iso -m 1G -serial stdio

# With disk (persistent storage)
qemu-system-i386 -cdrom jsos.iso -m 512M \
  -drive file=jsos-disk.img,format=raw \
  -serial stdio
```

### 3. OCI / Docker Container (item 907)

JSOS can run in a container for development and testing (not bare metal, just the JS runtime):

```bash
docker build -f docker/test.Dockerfile -t jsos:latest .
docker run --rm -it jsos:latest
```

The container runs the JS bundle under Node.js with a POSIX shim — useful for testing
application code without a full QEMU boot.

### 4. Raspberry Pi 4 (item 908)

1. Build the ARM64 image: `bash scripts/build-pi4-image.sh`
2. Flash to SD: `dd if=jsos-pi4.img of=/dev/sdX bs=4M status=progress`
3. Insert SD into Pi 4, connect HDMI and USB keyboard, power on

The Pi 4 port uses the `RaspberryPi4Arch` platform driver
(`src/os/process/arch.ts`) which targets the ARM64 Generic Timer and GIC-400.

### 5. PXE Network Boot (item 909)

Set up a DHCP/TFTP server pointing to:
```
pxelinux.cfg/default → chainload to grub
grub/grub.cfg         → tftp://server/boot/bundle.js
```

Example GRUB PXE config:
```
set default=0
set timeout=5

menuentry "JSOS" {
  set root=(tftp)
  linux /boot/kernel.bin loglevel=4 console=ttyS0
  initrd /boot/bundle.js
  boot
}
```

## Cloud Deployment

### cloud-init

JSOS supports cloud-init user-data at first boot (see `src/os/core/cloud-init.ts`).

Example user-data:
```yaml
#cloud-config
hostname: my-jsos-node
users:
  - name: admin
    passwd: "$6$hashed"
    sudo: true
write_files:
  - path: /home/admin/hello.js
    content: 'console.log("Hello from JSOS!")'
runcmd:
  - node /home/admin/hello.js
```

Provide via kernel command line:
```
cloud-init=<base64 of user-data>
```

Or mount a CD-ROM labeled `cidata` with `user-data` and `meta-data` files.

### EC2 / GCE

JSOS reads `http://169.254.169.254/latest/user-data` on first boot if no other
user-data source is found. This works with AWS EC2, GCE, and Azure IMDS.

## Disk Layout After Install

```
/dev/sda1  (64 MB)  ext4   /boot      — GRUB + bundle.js
/dev/sda2  (512 MB) swap   [swap]     — swap partition
/dev/sda3  (rest)   ext4   /          — root filesystem
```

## Upgrading

```bash
# In the JSOS REPL:
sys.storage.update('/boot/bundle.js', newBundleBytes);
sys.storage.computeAndWriteCRC('/boot/bundle.crc');
reboot();
```
