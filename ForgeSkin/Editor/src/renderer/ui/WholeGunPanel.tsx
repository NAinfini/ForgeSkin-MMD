// 整把枪 · 外观 · 整枪换模 (gunSwap.ts): one model in place of the whole gun, its hold points placed by the rule.
import { Button, Group, Text } from '@mantine/core';
import { IconRefresh, IconReplace, IconTrash } from '@tabler/icons-react';
import { importWholeGun, removeWholeGun, reseatWholeGun, wholeGunOf } from '../gunSwap';
import { useStore } from '../store';
import { t } from '../i18n';
import { Section } from './Features';

export function WholeGunPanel() {
  const model = useStore((s) => {
    const w = wholeGunOf(s.doc);
    return w ? (s.doc.attachments?.find((a) => a?.id === w.attachment) ?? null) : null;
  });
  return (
    <Section id="whole-gun" title={t('wholeGun.title')} icon={IconReplace} color="var(--flare)" info={t('wholeGun.info')}>
      {model && (
        <Text size="xs" mb={8} truncate>
          {t('wholeGun.current', { v0: model.name || model.id })}
        </Text>
      )}
      <Button fullWidth size="sm" color="orange" leftSection={<IconReplace size={16} />} onClick={() => void importWholeGun()} mb={model ? 8 : 0}>
        {model ? t('wholeGun.replace') : t('wholeGun.import')}
      </Button>
      {model && (
        <Group gap={6} grow>
          <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void reseatWholeGun()}>
            {t('wholeGun.reseat')}
          </Button>
          <Button size="xs" variant="subtle" color="gray" leftSection={<IconTrash size={14} />} onClick={removeWholeGun}>
            {t('wholeGun.remove')}
          </Button>
        </Group>
      )}
    </Section>
  );
}
