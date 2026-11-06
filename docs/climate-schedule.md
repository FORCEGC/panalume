# Climate schedule

A Panalume card for any climate entity: a thermostat, an air conditioner, a heat pump. It is not tied to a particular home or a particular brand.

Each thermostat has up to eight times. A time has a start, the days it runs, a mode and a temperature. The card draws today as a bar with a marker for now. Switching the schedule on applies the time that is already in force. Changing the thermostat by hand shows **Changed by hand** and a **Resume** button. For about a minute and a half after a time starts, or after Resume, the card does not call that a hand change, so a slow unit is not flagged while the command is still landing.

Mode buttons are the entity's own `hvac_modes` (`off`, `cool`, `heat`, `heat_cool`, `auto`, `dry`, `fan_only`, and only the ones that entity has). The stepper stays inside `min_temp` and `max_temp`, and uses the entity's step and temperature unit. Heat/cool sets a low and a high (`target_temp_low` / `target_temp_high`) when the entity supports a range.

The dashboard does not keep running after you close it, so Home Assistant itself applies the schedule. That is the package below. One file covers every thermostat you list.

## Set it up

1. On the Panalume machine (or any machine with this repo), write the package from your entity ids:

   ```sh
   python3 docs/climate-schedule.py climate.living_room climate.bedroom > climate_schedule.yaml
   ```

   `docs/climate-schedule.yaml` is that command run for `climate.living_room`, if you would rather start from a sample and edit it.

2. Copy the file to `/config/packages/climate_schedule.yaml`.

3. In `configuration.yaml`:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

4. Check the configuration and restart Home Assistant once.

5. In Panalume, add **Climate schedule** and pick the thermostats. If the helpers already exist, the card fills them in. One thermostat is a single card; two or more are tabs, named from each entity. A thermostat card's hold action can open this card as a pop-up.

You only choose the entity id. The object id (the part after `climate.`) names the helpers:

| Entity | Schedule text | On / off |
| --- | --- | --- |
| `climate.living_room` | `input_text.living_room_climate_schedule` | `input_boolean.living_room_climate_schedule_enabled` |

Every thermostat shares `script.climate_schedule_apply`. The schedule starts **off** until you turn it on.

To add another thermostat later, run the command again with the full list, or duplicate one helper pair in the YAML, add its switch to the automation's trigger, and add the climate entity under `for_each`.

## What a command does

The script sets the mode, then the temperature. It does not call the service when the entity is already on that mode and already at that temperature. Heat/cool sends `target_temp_low` and `target_temp_high`. Off and fan-only do not send a temperature. Dry sends one only when the entity accepts a single target.

The automation looks once a minute. It sends a command only when a time **starts** that minute, so a change you made by hand stays until the next time. Switching the schedule from off to on (on the card, or the switch in Home Assistant) applies the time that is in force now, including one that started earlier today or on a previous day.

A unit that only accepts one command at a time can wait between the mode and the temperature. In the script field `gap`, set `default` to a few seconds (for example `3`). `0` is right for a normal thermostat. The pause is shared by every thermostat in the file. You can also pass `--gap 3` to the generator.

```sh
python3 docs/climate-schedule.py --gap 3 climate.living_room
```

## The text in the helper

255 characters, which is as long as a Home Assistant text helper can be. Eight times fit, including heat/cool with two whole-number temperatures. A decimal on every heat/cool time runs past 255 before the eighth time; the card then asks you to remove a time instead of saving a cut-off schedule.

```json
[["0630","1111100","h",20],["2200","1111111","r",19,23]]
```

Each item is `[start HHMM, days Mon–Sun as 1/0, mode, temperature]`. A fifth number is the high target.

| Letter | Mode |
| --- | --- |
| `h` | heat |
| `c` | cool |
| `o` | off |
| `r` | heat_cool |
| `a` | auto |
| `d` | dry |
| `f` | fan_only |

Times use Home Assistant's time zone (Settings → System → General).

Resume calls `script.climate_schedule_apply`. Switching the schedule on only turns the switch helper on; the automation sees that and applies the current time through the same script. If the script is not installed, Resume calls `climate.set_hvac_mode` and `climate.set_temperature` itself, with the same "already there, so don't send" check. The minute-by-minute schedule still needs the automation.

Restarting Home Assistant does not re-apply the current time (a hand change survives a restart). A commented trigger in the package turns that on if you want it.
