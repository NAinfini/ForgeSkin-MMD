// First start: what making a character skin takes, in four lines, with the two ways in (import a model, read the guide).
import { Button, Group, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBone, IconListCheck, IconUser, IconWind } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { chooseModel } from '../character/model';
import { useCharacter } from '../character/state';
import { useStore } from '../store';
import { t } from '../i18n';
import { openHelp } from './HelpDocs';

const SEEN = 'sf.welcome';
const seen = () => {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch {
    return true;
  }
};
const markSeen = () => {
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    // shown again next time
  }
};

const STEPS = [
  { icon: IconUser, color: 'orange', key: 'character.welcome.import' },
  { icon: IconBone, color: 'cyan', key: 'character.welcome.bones' },
  { icon: IconWind, color: 'violet', key: 'character.welcome.springs' },
  { icon: IconListCheck, color: 'green', key: 'character.welcome.check' },
] as const;

/** The first-start card, until a model is imported or it is closed; Settings ▸ 使用指南 brings the guide back. Only a real
 * first start sees it: with works on disk, or the last character opening with the window, the author is past it, so it is
 * marked seen instead of flashing up for the second it takes the character to load. */
export function Welcome() {
  const ready = useStore((s) => s.ready);
  const works = useStore((s) => s.characters.length);
  const model = useCharacter((s) => s.model);
  const [closed, setClosed] = useState(seen);
  const close = () => {
    markSeen();
    setClosed(true);
  };
  useEffect(() => {
    if (model || works > 0) close();
  }, [model, works]);
  if (!ready || closed || works > 0 || model) return null;
  return (
    <Modal opened onClose={close} title={t('character.welcome.title')} centered size="md">
      <Stack gap="sm">
        <Text size="sm">{t('character.welcome.info')}</Text>
        {STEPS.map((x) => (
          <Group key={x.key} gap="sm" wrap="nowrap" align="center">
            <ThemeIcon size={28} radius="md" variant="light" color={x.color}>
              <x.icon size={16} />
            </ThemeIcon>
            <Text size="sm" fw={600}>
              {t(x.key)}
            </Text>
          </Group>
        ))}
        <Group justify="flex-end" mt="sm">
          <Button
            variant="default"
            onClick={() => {
              close();
              openHelp();
            }}
          >
            {t('help.docs')}
          </Button>
          <Button
            onClick={() => {
              close();
              void chooseModel();
            }}
          >
            {t('character.choose')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}