#!/usr/bin/env python3
"""Write a Home Assistant package for the Panalume Climate schedule card.

The only thing you list is the climate entity id. Helper ids are derived from it:

    climate.living_room
      → input_text.living_room_climate_schedule
      → input_boolean.living_room_climate_schedule_enabled

    python3 docs/climate-schedule.py climate.living_room climate.bedroom > climate_schedule.yaml

A unit that drops commands when two are sent together can take a pause (seconds)
between the mode and the temperature. It applies to every thermostat in the file:

    python3 docs/climate-schedule.py --gap 3 climate.living_room
"""

import argparse
import json
import re
import sys

ENTITY_RE = re.compile(r'^climate\.[a-z0-9_]+$')

# Latest slot that has already started (catch-up), or the slot that starts this
# minute (tick). Keep this in step with scheduledAt() in
# panalume/app/src/lib/climate-schedule.js — tick is the "starts now" half only.
DUE_TEMPLATE = """\
{%- set slug = repeat.item.split('.')[1] -%}
{%- set raw = states('input_text.' ~ slug ~ '_climate_schedule') -%}
{%- set items = (raw | from_json(default=[])) if raw not in ['unknown', 'unavailable', 'none', ''] else [] -%}
{%- set catchup = trigger.id == 'catchup' -%}
{%- set hm = now().strftime('%H%M') -%}
{%- set ns = namespace(hit='', t='') -%}
{%- for k in range(8 if catchup else 1) -%}
{%- if ns.hit == '' -%}
{%- set wd = (now() - timedelta(days=k)).weekday() -%}
{%- for x in items if x is not string and x is sequence and (x | length) >= 4 and x[0] is string and x[1] is string and (x[1] | length) == 7 and x[2] is string and x[2] is match('^[a-z][a-z0-9_]{0,20}$') and x[3] is number and ((x | length) < 5 or x[4] is number) and x[0] is match('^([01][0-9]|2[0-3])[0-5][0-9]$') -%}
{%- set ok = (k > 0 or x[0] <= hm) if catchup else (x[0] == hm) -%}
{%- if ok and x[1][wd] == '1' and x[0] >= ns.t -%}
{%- set ns.t = x[0] -%}
{%- set ns.hit = x[0] ~ '|' ~ x[1] ~ '|' ~ x[2] ~ '|' ~ (x[3] | string) ~ ('' if (x | length) < 5 else '|' ~ (x[4] | string)) -%}
{%- endif -%}
{%- endfor -%}
{%- endif -%}
{%- endfor -%}
{{- ns.hit -}}"""

# Same rules as tempKind() in climate-schedule.js.
KIND_TEMPLATE = """\
{%- set feats = state_attr(entity_id, 'supported_features') | int(0) -%}
{%- set known = feats > 0 -%}
{%- set has_single = known and (feats % 2 == 1) -%}
{%- set has_range = known and ((feats // 2) % 2 == 1) -%}
{%- if mode in ['off', 'fan_only'] -%}none
{%- elif mode == 'heat_cool' -%}{{ 'range' if (has_range or not has_single) else 'single' }}
{%- elif has_range and not has_single -%}range
{%- elif mode == 'dry' -%}{{ 'single' if has_single else 'none' }}
{%- elif has_single or not known -%}single
{%- else -%}none
{%- endif -%}"""


def slug_of(entity_id):
    if not ENTITY_RE.fullmatch(entity_id):
        raise SystemExit(
            f'{entity_id!r} is not a climate entity id like climate.living_room '
            '(lowercase letters, numbers and underscores).'
        )
    return entity_id.split('.', 1)[1]


def title_of(slug, labels):
    entity_id = f'climate.{slug}'
    if entity_id in labels:
        return labels[entity_id]
    text = slug.replace('_', ' ')
    return text[:1].upper() + text[1:]


def yaml_str(value):
    return json.dumps(value, ensure_ascii=False)


def gap_literal(gap):
    if isinstance(gap, float) and gap.is_integer():
        return str(int(gap))
    return str(gap)


def render(entities, labels=None, gap=0):
    labels = labels or {}
    slugs = []
    seen = set()
    for entity_id in entities:
        slug = slug_of(entity_id)
        if slug in seen:
            raise SystemExit(f'{entity_id} is listed twice.')
        seen.add(slug)
        slugs.append(slug)
    if not 0 <= float(gap) <= 30:
        raise SystemExit('--gap must be between 0 and 30 seconds.')

    listed = ', '.join(f'climate.{slug}' for slug in slugs)
    names = ' '.join(f'climate.{slug}' for slug in slugs)
    lines = [
        '# Climate schedule for Panalume.',
        '#',
        '# Copy this file to /config/packages/climate_schedule.yaml and make sure',
        '# configuration.yaml contains:',
        '#',
        '#   homeassistant:',
        '#     packages: !include_dir_named packages',
        '#',
        '# Check the configuration, then restart Home Assistant once.',
        '#',
        f'# This file is for: {listed}',
        '# To rebuild it from a list of entity ids (from the panalume repo):',
        '#',
        f'#   python3 docs/climate-schedule.py {names}',
        '#',
        '# Or add a thermostat by hand: duplicate one helper pair, add its switch to',
        '# the automation trigger, and add the climate entity under for_each.',
        '# The object id is the part after "climate." — climate.living_room → living_room.',
        '#',
        '# Each thermostat gets:',
        '#   input_text.<object_id>_climate_schedule',
        '#   input_boolean.<object_id>_climate_schedule_enabled     (starts off)',
        '# and every thermostat shares:',
        '#   script.climate_schedule_apply',
        '#',
        '# What the card saves, 255 characters at most:',
        '#   [["0630","1111100","h",20],["2200","1111111","r",19,23]]',
        '#   [start HHMM, days Mon..Sun as 1/0, mode, temperature]',
        '#   h heat, c cool, o off, r heat_cool, a auto, d dry, f fan_only',
        '#   A fifth number is the high target, used for heat/cool range.',
        '# Times follow Home Assistant\'s time zone (Settings → System → General).',
        '',
        'input_boolean:',
    ]
    for slug in slugs:
        title = title_of(slug, labels)
        lines += [
            f'  {slug}_climate_schedule_enabled:',
            f'    name: {yaml_str(title + " climate schedule")}',
            '    icon: mdi:calendar-clock',
        ]
    lines += ['', 'input_text:']
    for slug in slugs:
        title = title_of(slug, labels)
        lines += [
            f'  {slug}_climate_schedule:',
            f'    name: {yaml_str(title + " climate schedule data")}',
            '    icon: mdi:calendar-edit',
            '    min: 0',
            '    max: 255',
            '    mode: text',
            '    initial: "[]"',
        ]
    lines += [
        '',
        'script:',
        '  climate_schedule_apply:',
        '    alias: Climate schedule — apply',
        '    description: >-',
        '      Puts one climate entity on the mode and temperature it was given.',
        '      Skips a call when the entity is already there. Used by the',
        '      climate schedule automation and by the Climate schedule card.',
        '    mode: queued',
        '    max: 10',
        '    max_exceeded: silent',
        '    fields:',
        '      entity_id:',
        '        name: Climate entity',
        '        required: true',
        '        selector:',
        '          entity:',
        '            domain: climate',
        '      mode:',
        '        name: Mode',
        '        required: true',
        '        selector:',
        '          select:',
        '            options:',
        '              - "off"',
        '              - "cool"',
        '              - "heat"',
        '              - "heat_cool"',
        '              - "auto"',
        '              - "dry"',
        '              - "fan_only"',
        '      temp:',
        '        name: Temperature (low, when this is a range)',
        '        required: false',
        '        selector:',
        '          number:',
        '            min: -50',
        '            max: 100',
        '            step: 0.5',
        '            mode: box',
        '      temp_high:',
        '        name: High temperature',
        '        description: For heat/cool range. Leave empty for a single target.',
        '        required: false',
        '        selector:',
        '          number:',
        '            min: -50',
        '            max: 100',
        '            step: 0.5',
        '            mode: box',
        '      gap:',
        '        name: Pause between commands (seconds)',
        '        description: >-',
        '          For a unit that only accepts one command at a time, set default',
        '          to a few seconds (for example 3). Normal thermostats stay at 0.',
        '          This pause is shared by every thermostat in this file.',
        f'        default: {gap_literal(gap)}',
        '        selector:',
        '          number:',
        '            min: 0',
        '            max: 30',
        '            step: 1',
        '            mode: box',
        '    sequence:',
        '      - variables:',
        '          kind: >-',
        *['            ' + line for line in KIND_TEMPLATE.split('\n')],
        '          high: >-',
        '            {%- set h = temp_high | float(none) -%}',
        '            {%- if h is number -%}{{ h }}',
        '            {%- else -%}{{ (temp | float(0)) + (6 if state_attr(entity_id, \'temperature_unit\') == \'°F\' else 3) }}',
        '            {%- endif -%}',
        '          cur: >-',
        '            {%- set ns = namespace(c=state_attr(entity_id, \'temperature\')) -%}',
        '            {%- if ns.c is none or ns.c is not number -%}',
        '            {%- set ns.c = state_attr(entity_id, \'target_temp_low\') -%}',
        '            {%- endif -%}',
        '            {%- if ns.c is number -%}{{ ns.c }}{%- endif -%}',
        '      - if:',
        '          - condition: template',
        '            value_template: "{{ not is_state(entity_id, mode) }}"',
        '        then:',
        '          - action: climate.set_hvac_mode',
        '            target:',
        '              entity_id: "{{ entity_id }}"',
        '            data:',
        '              hvac_mode: "{{ mode }}"',
        '          - if:',
        '              - condition: template',
        '                value_template: "{{ gap | float(0) > 0 and mode != \'off\' }}"',
        '            then:',
        '              - delay:',
        '                  seconds: "{{ [gap | float(0), 30] | min }}"',
        '      - if:',
        '          - condition: template',
        '            value_template: >-',
        '              {% set k = kind | trim %}',
        '              {% set want = temp | float(0) %}',
        '              {% set hi = high | float(want) %}',
        '              {% set current = cur | float(none) %}',
        '              {{ k != \'none\' and (',
        '                (k == \'range\' and (',
        '                  state_attr(entity_id, \'target_temp_low\') | float(none) is not number',
        '                  or ((state_attr(entity_id, \'target_temp_low\') | float(0) - want) | abs) > 0.05',
        '                  or state_attr(entity_id, \'target_temp_high\') | float(none) is not number',
        '                  or ((state_attr(entity_id, \'target_temp_high\') | float(0) - hi) | abs) > 0.05',
        '                ))',
        '                or (k == \'single\' and (',
        '                  current is not number or ((current - want) | abs) > 0.05',
        '                ))',
        '              ) }}',
        '        then:',
        '          - choose:',
        '              - conditions:',
        '                  - condition: template',
        '                    value_template: "{{ (kind | trim) == \'range\' }}"',
        '                sequence:',
        '                  - action: climate.set_temperature',
        '                    target:',
        '                      entity_id: "{{ entity_id }}"',
        '                    data:',
        '                      target_temp_low: "{{ temp | float(0) }}"',
        '                      target_temp_high: "{{ high | float(temp | float(0)) }}"',
        '            default:',
        '              - action: climate.set_temperature',
        '                target:',
        '                  entity_id: "{{ entity_id }}"',
        '                data:',
        '                  temperature: "{{ temp | float(0) }}"',
        '',
        'automation:',
        '  - id: climate_schedule',
        '    alias: Climate schedule',
        '    description: >-',
        '      Applies each thermostat\'s schedule. Edit the times on the Climate',
        '      schedule card. A minute with no starting time does not send a command,',
        '      so a change made by hand stays until the next time (or until the',
        '      schedule is switched on, which applies the time in force now).',
        '    mode: queued',
        '    max: 10',
        '    max_exceeded: silent',
        '    triggers:',
        '      - trigger: time_pattern',
        '        minutes: "/1"',
        '        id: tick',
        '      - trigger: state',
        '        entity_id:',
    ]
    for slug in slugs:
        lines.append(f'          - input_boolean.{slug}_climate_schedule_enabled')
    lines += [
        '        from: "off"',
        '        to: "on"',
        '        id: catchup',
        '      # Optional: also re-apply every schedule that is switched on when',
        '      # Home Assistant starts. That overrides a change made by hand before',
        '      # the restart, so leave it commented unless you want that.',
        '      # - trigger: homeassistant',
        '      #   event: start',
        '      #   id: catchup',
        '    actions:',
        '      - repeat:',
        '          for_each:',
    ]
    for slug in slugs:
        lines.append(f'            - climate.{slug}')
    lines += [
        '        sequence:',
        '          - variables:',
        '              due: >-',
        *['                ' + line for line in DUE_TEMPLATE.split('\n')],
        '          - if:',
        '              - condition: template',
        '                value_template: >-',
        '                  {%- set slug = repeat.item.split(\'.\')[1] -%}',
        '                  {%- set switch = \'input_boolean.\' ~ slug ~ \'_climate_schedule_enabled\' -%}',
        '                  {%- set who = trigger.entity_id | default(\'\') if trigger.id == \'catchup\' else \'\' -%}',
        '                  {%- set mine = trigger.id != \'catchup\' or who == \'\' or who == switch -%}',
        '                  {{ is_state(switch, \'on\') and mine and (due | trim | length > 0)',
        '                     and states(repeat.item) not in [\'unknown\', \'unavailable\', \'none\', \'\'] }}',
        '            then:',
        '              - variables:',
        '                  mode_name: >-',
        '                    {%- set code = (due | trim).split(\'|\')[2] -%}',
        '                    {%- set cmap = {\'h\': \'heat\', \'c\': \'cool\', \'o\': \'off\', \'r\': \'heat_cool\', \'a\': \'auto\', \'d\': \'dry\', \'f\': \'fan_only\'} -%}',
        '                    {{- cmap.get(code, code) -}}',
        '                  temp_value: "{{ (due | trim).split(\'|\')[3] | float(0) }}"',
        '                  temp_high_value: "{{ (due | trim).split(\'|\')[4] if (due | trim).split(\'|\') | length > 4 else \'\' }}"',
        '              - action: script.climate_schedule_apply',
        '                data:',
        '                  entity_id: "{{ repeat.item }}"',
        '                  mode: "{{ mode_name }}"',
        '                  temp: "{{ temp_value }}"',
        '                  temp_high: "{{ temp_high_value }}"',
        '',
    ]
    return '\n'.join(lines)


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('entities', nargs='+', help='climate entity ids, e.g. climate.living_room')
    parser.add_argument('--gap', type=float, default=0, help='seconds between mode and temperature (default 0)')
    parser.add_argument('--label', action='append', default=[], metavar='ENTITY=NAME', help='helper name, e.g. climate.living_room=Living room')
    return parser.parse_args(argv)


def labels_from(pairs):
    labels = {}
    for pair in pairs:
        if '=' not in pair:
            raise SystemExit(f'--label must look like climate.living_room=Living room, not {pair!r}')
        entity_id, name = pair.split('=', 1)
        slug_of(entity_id)
        name = name.strip()
        if not name:
            raise SystemExit(f'--label {entity_id} needs a name.')
        labels[entity_id] = name
    return labels


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    text = render(args.entities, labels_from(args.label), args.gap)
    sys.stdout.write(text)


if __name__ == '__main__':
    main()
