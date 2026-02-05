#!/data/data/com.termux/files/usr/bin/bash
#
# Cobrain Phone Agent
# Runs on Android phone via Termux
#
# Usage: ./phone-agent.sh [COBRAIN_URL] [DEVICE_ID] [PORT]
#

# Configuration
COBRAIN_URL="${1:-http://100.114.23.43:11088}"
DEVICE_ID="${2:-huawei-p10}"
AGENT_PORT="${3:-8888}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════╗"
echo "║     🤖 Cobrain Phone Agent            ║"
echo "╠═══════════════════════════════════════╣"
echo "║  Device: $DEVICE_ID"
echo "║  Cobrain: $COBRAIN_URL"
echo "║  Port: $AGENT_PORT"
echo "╚═══════════════════════════════════════╝"
echo -e "${NC}"

# Check dependencies
check_deps() {
  local missing=()

  command -v termux-camera-photo >/dev/null || missing+=("termux-api")
  command -v curl >/dev/null || missing+=("curl")
  command -v nc >/dev/null || missing+=("netcat-openbsd")

  if [ ${#missing[@]} -gt 0 ]; then
    echo -e "${RED}Missing packages: ${missing[*]}${NC}"
    echo "Installing..."
    pkg install -y "${missing[@]}"
  fi
}

# Register with Cobrain
register() {
  echo -e "${YELLOW}Registering with Cobrain...${NC}"

  # Get device capabilities
  local caps='["camera", "microphone", "location"]'

  curl -s -X POST "$COBRAIN_URL/api/phone/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"id\": \"$DEVICE_ID\",
      \"name\": \"$DEVICE_ID\",
      \"port\": $AGENT_PORT,
      \"capabilities\": $caps
    }" | jq . 2>/dev/null || echo "Registered (no jq)"

  echo -e "${GREEN}✓ Registered${NC}"
}

# Send heartbeat
heartbeat() {
  curl -s -X POST "$COBRAIN_URL/api/phone/heartbeat" \
    -H "Content-Type: application/json" \
    -d "{\"id\": \"$DEVICE_ID\"}" >/dev/null 2>&1
}

# Take photo and send
take_photo() {
  local camera="${1:-1}"  # 0=back, 1=front
  local filename="/data/data/com.termux/files/home/photo_$(date +%s).jpg"

  echo -e "${BLUE}📸 Taking photo (camera $camera)...${NC}"
  termux-camera-photo -c "$camera" "$filename"

  if [ -f "$filename" ]; then
    echo -e "${YELLOW}📤 Uploading...${NC}"
    curl -s -X POST "$COBRAIN_URL/api/phone/photo" \
      -F "image=@$filename" \
      -F "device_id=$DEVICE_ID" | jq . 2>/dev/null || echo "Uploaded"
    rm -f "$filename"
    echo -e "${GREEN}✓ Photo sent${NC}"
  else
    echo -e "${RED}✗ Failed to take photo${NC}"
  fi
}

# Record audio and send
record_audio() {
  local duration="${1:-5}"
  local filename="/data/data/com.termux/files/home/audio_$(date +%s).wav"

  echo -e "${BLUE}🎤 Recording ${duration}s audio...${NC}"
  termux-microphone-record -l "$duration" -f "$filename"

  # Wait for recording to complete
  sleep "$((duration + 1))"

  if [ -f "$filename" ]; then
    echo -e "${YELLOW}📤 Uploading...${NC}"
    curl -s -X POST "$COBRAIN_URL/api/phone/audio" \
      -F "audio=@$filename" \
      -F "device_id=$DEVICE_ID" | jq . 2>/dev/null || echo "Uploaded"
    rm -f "$filename"
    echo -e "${GREEN}✓ Audio sent${NC}"
  else
    echo -e "${RED}✗ Failed to record audio${NC}"
  fi
}

# Get location and send
send_location() {
  echo -e "${BLUE}📍 Getting location...${NC}"
  local loc=$(termux-location -p network 2>/dev/null || termux-location 2>/dev/null)

  if [ -n "$loc" ]; then
    local lat=$(echo "$loc" | jq -r '.latitude')
    local lon=$(echo "$loc" | jq -r '.longitude')
    local acc=$(echo "$loc" | jq -r '.accuracy')

    curl -s -X POST "$COBRAIN_URL/api/phone/location" \
      -H "Content-Type: application/json" \
      -d "{
        \"device_id\": \"$DEVICE_ID\",
        \"latitude\": $lat,
        \"longitude\": $lon,
        \"accuracy\": $acc
      }" | jq . 2>/dev/null || echo "Sent"
    echo -e "${GREEN}✓ Location sent: $lat, $lon${NC}"
  else
    echo -e "${RED}✗ Failed to get location${NC}"
  fi
}

# Get battery info
get_battery() {
  termux-battery-status 2>/dev/null | jq .
}

# Handle incoming command
handle_command() {
  local cmd="$1"
  local params="$2"

  echo -e "${YELLOW}Command: $cmd${NC}"

  case "$cmd" in
    "photo")
      local camera=$(echo "$params" | jq -r '.camera // "front"')
      [ "$camera" = "front" ] && camera=1 || camera=0
      take_photo "$camera"
      ;;
    "audio")
      local duration=$(echo "$params" | jq -r '.duration // 5')
      record_audio "$duration"
      ;;
    "location")
      send_location
      ;;
    "battery")
      get_battery
      ;;
    "info")
      echo "Device: $DEVICE_ID"
      termux-info 2>/dev/null || echo "Termux info not available"
      ;;
    *)
      echo -e "${RED}Unknown command: $cmd${NC}"
      ;;
  esac
}

# Simple HTTP server to receive commands
start_server() {
  echo -e "${GREEN}🚀 Starting command server on port $AGENT_PORT...${NC}"
  echo -e "${YELLOW}Waiting for commands...${NC}"

  while true; do
    # Listen for incoming connection
    local request=$(nc -l -p "$AGENT_PORT" -q 1)

    if [ -n "$request" ]; then
      # Parse HTTP request
      local body=$(echo "$request" | tail -1)

      if [ -n "$body" ] && [ "$body" != "" ]; then
        local cmd=$(echo "$body" | jq -r '.command // empty' 2>/dev/null)
        local params=$(echo "$body" | jq -r '.params // {}' 2>/dev/null)

        if [ -n "$cmd" ]; then
          handle_command "$cmd" "$params"
          # Send response
          echo -e "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"success\":true}"
        fi
      fi
    fi
  done
}

# Heartbeat loop (background)
heartbeat_loop() {
  while true; do
    heartbeat
    sleep 30
  done
}

# Main
main() {
  check_deps
  register

  # Start heartbeat in background
  heartbeat_loop &
  HEARTBEAT_PID=$!

  # Trap to cleanup on exit
  trap "kill $HEARTBEAT_PID 2>/dev/null; exit" INT TERM

  # Start command server
  start_server
}

# Run
main
