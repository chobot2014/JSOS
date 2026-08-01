$bytes = [System.IO.File]::ReadAllBytes("$PSScriptRoot\..\test-output\capture.pcap")
$pos = 24  # skip global header
$pktIdx = 0
$googlePkts = @()

while ($pos + 16 -le $bytes.Length) {
    $inclLen = [BitConverter]::ToUInt32($bytes, $pos + 8)
    if ($pos + 16 + $inclLen -gt $bytes.Length) { break }

    $o = $pos + 16  # start of packet data (Ethernet frame)

    if ($inclLen -ge 54) {
        # Parse Ethernet
        $b12 = [int]$bytes[$o + 12]
        $b13 = [int]$bytes[$o + 13]
        $ethType = ($b12 -shl 8) -bor $b13

        if ($ethType -eq 0x0800) {
            # IPv4
            $ihl = ([int]$bytes[$o + 14] -band 0x0F) * 4
            $proto = [int]$bytes[$o + 23]
            $srcIP = "$($bytes[$o+26]).$($bytes[$o+27]).$($bytes[$o+28]).$($bytes[$o+29])"
            $dstIP = "$($bytes[$o+30]).$($bytes[$o+31]).$($bytes[$o+32]).$($bytes[$o+33])"

            if ($proto -eq 6) {
                # TCP
                $tcpOff = $o + 14 + $ihl
                $srcPort = ([int]$bytes[$tcpOff] -shl 8) -bor [int]$bytes[$tcpOff + 1]
                $dstPort = ([int]$bytes[$tcpOff + 2] -shl 8) -bor [int]$bytes[$tcpOff + 3]
                $seq = ([int]$bytes[$tcpOff+4] -shl 24) -bor ([int]$bytes[$tcpOff+5] -shl 16) -bor ([int]$bytes[$tcpOff+6] -shl 8) -bor [int]$bytes[$tcpOff+7]
                $ack = ([int]$bytes[$tcpOff+8] -shl 24) -bor ([int]$bytes[$tcpOff+9] -shl 16) -bor ([int]$bytes[$tcpOff+10] -shl 8) -bor [int]$bytes[$tcpOff+11]
                $dataOff = (([int]$bytes[$tcpOff + 12] -shr 4) -band 0x0F) * 4
                $flags = [int]$bytes[$tcpOff + 13]
                $window = ([int]$bytes[$tcpOff+14] -shl 8) -bor [int]$bytes[$tcpOff+15]
                $payLen = $inclLen - (14 + $ihl + $dataOff)

                if ($srcPort -eq 443 -or $dstPort -eq 443) {
                    $fl = ""
                    if ($flags -band 2) { $fl += "S" }
                    if ($flags -band 16) { $fl += "A" }
                    if ($flags -band 8) { $fl += "P" }
                    if ($flags -band 1) { $fl += "F" }
                    if ($flags -band 4) { $fl += "R" }

                    $dir = if ($srcPort -eq 443) { "<-" } else { "->" }
                    Write-Host ("{0,4} {1} {2}:{3} {4}:{5} seq={6} ack={7} len={8} F={9} win={10}" -f $pktIdx, $dir, $srcIP, $srcPort, $dstIP, $dstPort, $seq, $ack, $payLen, $fl, $window)
                }
            }
        }
    }

    $pos += 16 + $inclLen
    $pktIdx++
}

Write-Host "`nTotal packets: $pktIdx"
