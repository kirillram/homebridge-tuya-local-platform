# Installation

## Option 1: Homebridge Config UI X

1. Uninstall `@nubisco/homebridge-tuya-local-platform` if it is still installed (only one Tuya Local platform plugin can be active).
2. Open the Homebridge UI → **Plugins**.
3. Search for `@kirillram/homebridge-tuya-local-platform` (or install from a local folder / GitHub).
4. Restart Homebridge.

## Option 2: Local copy (this repo)

Homebridge only loads plugins from its own `node_modules`, not from a random rsync folder.

On the Homebridge host:

```bash
# remove the upstream plugin so it does not steal the platform alias
npm uninstall -g @nubisco/homebridge-tuya-local-platform

# install this fork into Homebridge (adjust paths to match your host)
cd /var/lib/homebridge
npm install /home/pi/homebridge-tuya-local-platform
sudo hb-service restart
```

## Verify

In Homebridge logs you should see this plugin load as `@kirillram/homebridge-tuya-local-platform`.

Config must use the platform alias (same as the original plugin):

```json
{
  "platform": "TuyaLocalPlatform",
  "name": "TuyaLocalPlatform",
  "devices": []
}
```

Do **not** use `KirillTuyaLocalPlatform` — Config UI X will ignore that block.

## Upgrading from `@nubisco/homebridge-tuya-local-platform`

1. Uninstall the old plugin.
2. Install `@kirillram/homebridge-tuya-local-platform` into Homebridge as above.
3. Keep `"platform": "TuyaLocalPlatform"` in `config.json`.
4. Restart Homebridge.

Device field configurations remain compatible. HomeKit accessory UUIDs change with the new npm package name, so accessories may need to be re-added in the Home app.
