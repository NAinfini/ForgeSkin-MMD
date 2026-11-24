// Inspector rows composed from Mantine inputs. A value is stored as the character document stores it (metres, degrees);
// `scale` converts for display (e.g. metres shown as centimetres).
import { NumberInput, Slider as MSlider, Text, type NumberInputProps } from '@mantine/core';
import type { ReactNode } from 'react';

/** A labelled control; the label also names the group, so assistive tools find the control by it. The label sits in a
 *  column beside the control, or above it when the panel is narrow (styles.css). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <div className="field-control">{children}</div>
    </div>
  );
}

interface NumProps extends Omit<NumberInputProps, 'value' | 'onChange'> {
  value: number;
  onChange: (v: number) => void;
  scale?: number;
  label?: string;
}

export function Num({ value, onChange, scale = 1, label, decimalScale = 2, ...rest }: NumProps) {
  return (
    <NumberInput
      value={+(value * scale).toFixed(decimalScale)}
      decimalScale={decimalScale}
      onChange={(v) => typeof v === 'number' && onChange(v / scale)}
      leftSection={
        label && (
          <Text size="xs" fw={700} ff="monospace">
            {label}
          </Text>
        )
      }
      leftSectionWidth={label ? 18 : undefined}
      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', paddingRight: rest.hideControls ? 4 : undefined } }}
      {...rest}
    />
  );
}

/** A slider with the exact value beside it; `unit` (" cm", "°", " Hz") follows the number in both. */
export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  unit = '',
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: (v: number) => string;
}) {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return (
    <div className="slider-row">
      <MSlider size="sm" value={value} min={min} max={max} step={step} onChange={onChange} label={label ?? ((v) => `${v.toFixed(digits)}${unit}`)} />
      <Num hideControls value={value} min={min} max={max} step={step * 10} decimalScale={digits} suffix={unit} onChange={onChange} />
    </div>
  );
}