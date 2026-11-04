import {
  Autocomplete, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, MenuItem, Stack, Tab, Tabs, TextField,
} from '@mui/material';
import { useColorScheme } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCALES, PRONOUNS, type Locale, type Pronoun, type SettingsInput } from '#shared/employee.ts';
import { defaultKeyboards, KEYBOARDS } from '#shared/keyboards.ts';
import { deleteAvatar, uploadAvatar } from '#client/hooks/avatar.ts';
import { useSignedOut } from '#client/hooks/session.ts';
import { useMe } from '#client/hooks/me.ts';
import { showInfo } from '#client/hooks/store.ts';
import { useTRPC } from '#client/hooks/trpc.ts';
import { fieldErrors } from '#client/i18n/errors.ts';
import EmailField from './EmailField.tsx';
import EmployeeAvatar from './EmployeeAvatar.tsx';
import Bots from '../MyDayPage/Bots.tsx';
import MyTags from './MyTags.tsx';
import { employeeFilter, employeeOption } from './employeeOption.tsx';

const TIME_ZONES = Intl.supportedValuesOf('timeZone');

// What the employee writes about themselves is saved with a button;
// everything picked from a list or a calendar applies at once.
export default function (p: { onClose: () => void }) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useMe();

  const [fullName, setFullName] = useState(me.fullName);
  const [about, setAbout] = useState(me.about ?? '');
  const dirty = fullName !== me.fullName || about !== (me.about ?? '');

  const refresh = () => queryClient.invalidateQueries();
  // Who I am, and my tags (colors and weights only I see).
  const [section, setSection] = useState<'profile' | 'tags' | 'bots'>('profile');
  // The picture is cropped and scaled in the browser, then uploaded around tRPC.
  const [avatarBusy, setAvatarBusy] = useState(false);
  const changeAvatar = async (action: () => Promise<void>) => {
    setAvatarBusy(true);
    try {
      await action();
      await refresh();
    } catch {
      // The error is already shown (hooks/avatar.ts).
    } finally {
      setAvatarBusy(false);
    }
  };
  const update = useMutation(
    trpc.Employee.updateProfile.mutationOptions({
      onSuccess: async () => {
        await refresh();
        showInfo(t('common.saved'));
      },
    }),
  );
  const settings = useMutation(trpc.Employee.updateSettings.mutationOptions({ onSuccess: refresh }));
  const setManager = useMutation(trpc.Employee.setManager.mutationOptions({ onSuccess: refresh }));
  const signedOut = useSignedOut();
  const logoutEverywhere = useMutation(
    trpc.Auth.logoutEverywhere.mutationOptions({ onSuccess: signedOut }),
  );
  const errors = fieldErrors(update.error);
  const settingErrors = fieldErrors(settings.error);
  const apply = (input: SettingsInput) => settings.mutate(input);
  // Light or dark is a matter of this screen, not of the account: kept in this browser.
  const { mode, setMode } = useColorScheme();

  const employees = useQuery(trpc.Employee.list.queryOptions());
  const candidates = (employees.data ?? []).filter((e) => e.kind === 'human' && e.dismissedAt === null && e.id !== me.id);
  const manager = candidates.find((e) => e.id === me.managerId) ?? null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ fullName, about: about.trim() || null });
  };

  return (
    <Dialog open onClose={p.onClose} fullWidth maxWidth="md" slotProps={{ paper: { sx: { height: 'min(720px, calc(100% - 64px))' } } }}>
      <DialogTitle sx={{ pb: 0 }}>{t('profile.title')}</DialogTitle>
      <Tabs value={section} onChange={(_, v: 'profile' | 'tags' | 'bots') => setSection(v)} sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="profile" label={t('profile.sectionProfile')} />
        <Tab value="tags" label={t('profile.sectionTags')} />
        <Tab value="bots" label={t('profile.sectionBots')} />
      </Tabs>
      <DialogContent>
        {section === 'bots' ? <Box sx={{ pt: 2 }}><Bots bare /></Box>
          : section === 'tags' ? <Box sx={{ pt: 2 }}><MyTags onOpen={p.onClose} /></Box> : (
        <Stack spacing={3} sx={{ pt: 2 }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <EmployeeAvatar employee={me} size={64} />
            <Button component="label" variant="outlined" size="small" disabled={avatarBusy}>
              {me.avatarAt ? t('profile.avatarChange') : t('profile.avatarUpload')}
              <input hidden type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void changeAvatar(() => uploadAvatar(f)); }} />
            </Button>
            {me.avatarAt && (
              <Button size="small" color="inherit" disabled={avatarBusy} onClick={() => void changeAvatar(deleteAvatar)}>
                {t('profile.avatarDelete')}
              </Button>
            )}
          </Stack>
          <Stack component="form" spacing={2} onSubmit={submit}>
            <TextField
              label={t('profile.fullName')}
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              error={!!errors.fullName}
              helperText={errors.fullName}
            />
            <EmailField />
            <TextField
              label={t('profile.about')}
              multiline
              minRows={2}
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              error={!!errors.about}
              helperText={errors.about ?? t('profile.aboutHint')}
            />
            <Button
              type="submit"
              variant="contained"
              disabled={!dirty || update.isPending}
              sx={{ alignSelf: 'flex-start' }}
            >
              {t('common.save')}
            </Button>
          </Stack>

          <Divider />

          <TextField
            label={t('profile.nextDay')}
            type="date"
            value={me.nextDay ?? ''}
            onChange={(e) => apply({ nextDay: e.target.value || null })}
            error={!!settingErrors.nextDay}
            helperText={settingErrors.nextDay ?? t('profile.nextDayHint')}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Autocomplete
            options={TIME_ZONES}
            value={me.timeZone}
            disableClearable
            onChange={(_e, value) => apply({ timeZone: value })}
            renderInput={(params) => <TextField {...params} label={t('profile.timeZone')} helperText={t('profile.timeZoneHint')} />}
          />
          <TextField
            select
            label={t('profile.locale')}
            value={me.locale}
            onChange={(e) => apply({ locale: e.target.value as Locale })}
          >
            {LOCALES.map((l) => (
              <MenuItem key={l} value={l}>
                {t(`locales.${l}`)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label={t('profile.pronoun')}
            value={me.pronoun ?? ''}
            onChange={(e) => apply({ pronoun: (e.target.value || null) as Pronoun | null })}
            helperText={t('profile.pronounHint')}
            slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
          >
            <MenuItem value="">{t('profile.pronouns.none')}</MenuItem>
            {PRONOUNS.map((value) => (
              <MenuItem key={value} value={value}>{t(`profile.pronouns.${value}`)}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label={t('profile.theme')}
            value={mode ?? 'system'}
            onChange={(e) => setMode(e.target.value as 'system' | 'light' | 'dark')}
            helperText={t('profile.themeHint')}
          >
            {(['system', 'light', 'dark'] as const).map((value) => (
              <MenuItem key={value} value={value}>{t(`profile.themes.${value}`)}</MenuItem>
            ))}
          </TextField>
          <Autocomplete
            multiple
            disableClearable
            options={[...KEYBOARDS]}
            value={me.keyboards ?? defaultKeyboards(me.locale)}
            getOptionLabel={(k) => t(`profile.keyboardNames.${k}`)}
            onChange={(_e, value) => value.length > 0 && apply({ keyboards: value })}
            renderInput={(params) => (
              <TextField {...params} label={t('profile.keyboards')} helperText={t('profile.keyboardsHint')} />
            )}
          />
          <Autocomplete
            options={candidates}
            value={manager}
            getOptionLabel={(e) => e.fullName}
            renderOption={(props, e) => employeeOption(props, e)}
            filterOptions={employeeFilter}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            onChange={(_e, value) => setManager.mutate({ managerId: value?.id ?? null })}
            renderInput={(params) => (
              <TextField {...params} label={t('profile.manager')} placeholder={t('profile.noManager')} />
            )}
          />
        </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Button color="error" onClick={() => logoutEverywhere.mutate()} disabled={logoutEverywhere.isPending}>
          {t('profile.logoutEverywhere')}
        </Button>
        <Button onClick={p.onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

