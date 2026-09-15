#!/usr/bin/env bash
# SHEIN BI boot clock sanity (added 2026-09-15 after the fnOS migration).
#
# Why this exists: on 2026-09-15 the guest read the hypervisor RTC as UTC while
# the RTC actually carried local wall-clock time, so the kernel set the system
# clock 8 hours ahead at boot. Every Persistent= timer then recorded a bogus
# LastTrigger and silently swallowed its daily slots; shein-bi-db-backup.timer
# lost all three 01:45/02:05/02:25 chances for 2026-09-16.
#
# /etc/adjtime (LOCAL vs UTC) has to agree with what the hypervisor actually
# presents, so this script derives the correct mode from the RTC itself instead
# of hardcoding one, pins the timezone against cloud-init, waits for NTP, and
# rewinds any persistent timer stamp left in the future by an earlier boot.
set -Eeuo pipefail

STATE=/srv/shein-bi/runtime/host-scheduler/clock-sanity.json
TZ_NAME=Asia/Shanghai
NTP_WAIT_SEC=90
RTC_UTC_TOLERANCE_SEC=300
PERSISTENT_TIMERS=(shein-bi-cloud-morning-chain.timer shein-bi-cloud-session-manager.timer shein-bi-db-backup.timer)

log() { printf '[clock-sanity] %s\n' "$*"; }
mkdir -p "$(dirname "$STATE")"

# 1. timezone: cloud-init re-applies its config on every boot and can revert
#    /etc/timezone (and /etc/localtime) back to the image default.
if [ "$(readlink -f /etc/localtime)" != "/usr/share/zoneinfo/$TZ_NAME" ]; then
  log "repairing /etc/localtime to $TZ_NAME"
  timedatectl set-timezone "$TZ_NAME"
fi
if [ "$(cat /etc/timezone 2>/dev/null || true)" != "$TZ_NAME" ]; then
  log "repairing /etc/timezone to $TZ_NAME"
  printf '%s\n' "$TZ_NAME" > /etc/timezone
fi

# 2. derive the RTC mode from the RTC content, so the guest and the hypervisor
#    can never disagree about whether /etc/adjtime means LOCAL or UTC.
rtc_mode=unknown
if [ -r /sys/class/rtc/rtc0/since_epoch ]; then
  rtc_epoch=$(cat /sys/class/rtc/rtc0/since_epoch)
  sys_epoch=$(date +%s)
  delta=$((rtc_epoch - sys_epoch))
  abs_delta=$delta
  if [ "$abs_delta" -lt 0 ]; then abs_delta=$((0 - abs_delta)); fi
  if [ "$abs_delta" -le "$RTC_UTC_TOLERANCE_SEC" ]; then
    rtc_mode=no
  else
    rtc_mode=yes
  fi
  current_mode=$(timedatectl show -p LocalRTC --value)
  if [ "$current_mode" != "$rtc_mode" ]; then
    log "aligning RTC mode: hypervisor presents $rtc_mode (delta ${delta}s), was $current_mode"
    timedatectl set-local-rtc "$rtc_mode"
  fi
  log "rtc mode=$rtc_mode delta=${delta}s"
else
  log 'WARNING /sys/class/rtc/rtc0/since_epoch unreadable; leaving RTC mode untouched'
fi

# 3. bounded wait so the Persistent= timers evaluate on a settled clock
synced=no
for _ in $(seq 1 "$NTP_WAIT_SEC"); do
  if [ "$(timedatectl show -p NTPSynchronized --value)" = yes ]; then synced=yes; break; fi
  sleep 1
done
if [ "$synced" != yes ]; then
  log "WARNING NTP not synchronized after ${NTP_WAIT_SEC}s; forcing a resync"
  systemctl restart systemd-timesyncd || true
  sleep 5
  if [ "$(timedatectl show -p NTPSynchronized --value)" = yes ]; then synced=yes; fi
fi

# 4. defensive: a persistent timer stamped far in the future already swallowed
#    its slots at an earlier boot; rewind the stamp so the next slot is real.
now=$(date +%s)
repaired=''
for timer in "${PERSISTENT_TIMERS[@]}"; do
  stamp="/var/lib/systemd/timers/stamp-$timer"
  [ -f "$stamp" ] || continue
  mtime=$(stat -c %Y "$stamp")
  if [ "$mtime" -gt $((now + 3600)) ]; then
    log "rewinding bogus future stamp for $timer"
    touch -d "@$now" "$stamp"
    repaired="$repaired $timer"
  fi
done

local_rtc=$(timedatectl show -p LocalRTC --value)
log "done synced=$synced localTime=$(date -Is) rtcLocal=$local_rtc repaired=${repaired:-none}"
printf '{"schemaVersion":"shein-bi-clock-sanity/v1","synced":"%s","localTime":"%s","localRtc":"%s","rtcMode":"%s","repairedStamps":"%s"}\n' \
  "$synced" "$(date -Is)" "$local_rtc" "$rtc_mode" "${repaired:-}" > "$STATE"
if [ "$synced" != yes ]; then exit 1; fi

