param(
  [string]$Distro = "Ubuntu-24.04"
)

. "$PSScriptRoot\use_utf8.ps1"

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$composeDir = Join-Path $repo "infra\metabase"
$tmpDir = Join-Path $repo "tmp"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

if (-not (Test-Path (Join-Path $composeDir ".env"))) {
  Copy-Item -LiteralPath (Join-Path $composeDir ".env.example") -Destination (Join-Path $composeDir ".env")
}

$wslComposeDir = (wsl -d $Distro -- wslpath -a "$composeDir").Trim()
$shellFile = Join-Path $tmpDir "start-metabase-wsl.sh"

$script = @'
set -e
mkdir -p /mnt/d/SheinBI/docker-data
if [ ! -f /mnt/d/SheinBI/docker-data/docker-data.ext4 ]; then
  truncate -s 80G /mnt/d/SheinBI/docker-data/docker-data.ext4
  mkfs.ext4 -F /mnt/d/SheinBI/docker-data/docker-data.ext4 >/tmp/shein-docker-mkfs.log
fi
sudo mkdir -p /mnt/wsl/shein-docker-data
if ! mountpoint -q /mnt/wsl/shein-docker-data; then
  sudo mount -o loop /mnt/d/SheinBI/docker-data/docker-data.ext4 /mnt/wsl/shein-docker-data
fi
sudo mkdir -p /mnt/wsl/shein-docker-data/docker
sudo mkdir -p /etc/docker
cat >/tmp/shein-docker-daemon.json <<'JSON'
{
  "data-root": "/mnt/wsl/shein-docker-data/docker"
}
JSON
sudo cp /tmp/shein-docker-daemon.json /etc/docker/daemon.json
if ! sudo docker info >/dev/null 2>&1; then
  sudo nohup dockerd --host=unix:///var/run/docker.sock >/tmp/dockerd.log 2>&1 &
  sleep 5
fi
sudo docker info --format 'DockerRootDir={{.DockerRootDir}}'
cd '__COMPOSE_DIR__'
sudo docker compose up -d
sudo docker compose ps
'@

$script = $script.Replace("__COMPOSE_DIR__", $wslComposeDir)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($shellFile, $script.Replace("`r`n", "`n"), $utf8NoBom)
$wslShellFile = (wsl -d $Distro -- wslpath -a "$shellFile").Trim()
wsl -d $Distro -- bash $wslShellFile
