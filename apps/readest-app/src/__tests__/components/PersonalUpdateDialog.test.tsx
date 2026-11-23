import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ReactNode } from 'react';
import PersonalUpdateDialog from '@/app/library/components/PersonalUpdateDialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {},
}));
vi.mock('@/components/Dialog', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation:
    () =>
    (key: string, values: Record<string, number | string> = {}) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name])),
}));

const call = vi.mocked(invoke);
const currentVersion = '0.12.20-personal.8';
const release = { versionCode: 12029, versionName: '0.12.20-personal.9', size: 57_000_000 };

beforeEach(() => call.mockReset());
afterEach(cleanup);

it('checks on open, then starts the installer only after the user chooses to update', async () => {
  call.mockResolvedValueOnce({ currentVersion, release }).mockResolvedValueOnce('installer');
  render(<PersonalUpdateDialog onClose={vi.fn()} />);
  await screen.findByText('Version 0.12.20-personal.8');
  expect(call.mock.calls.map(([command]) => command)).toEqual(['check_personal_update']);
  fireEvent.click(screen.getByRole('button', { name: 'Download and install' }));
  await screen.findByText('Confirm the update in the Android installer.');
  expect(call).toHaveBeenLastCalledWith('install_personal_update', {
    versionCode: 12029,
    onProgress: expect.anything(),
  });
});

it('returns to the install action after Android requests permission', async () => {
  call.mockResolvedValueOnce({ currentVersion, release }).mockResolvedValueOnce('permission');
  render(<PersonalUpdateDialog onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Download and install' }));
  await screen.findByText(
    'Allow installs from this app in Android settings, then return to continue.',
  );
  expect(screen.getByRole('button', { name: 'Continue installation' })).toBeTruthy();
});

it('can retry a network failure and shows when the installed version is current', async () => {
  call.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ currentVersion });
  render(<PersonalUpdateDialog onClose={vi.fn()} />);
  await screen.findByText('Error checking for updates');
  fireEvent.click(screen.getByRole('button', { name: 'Check Update' }));
  await screen.findByText('Already the latest version');
  expect(screen.queryByRole('button', { name: 'Download and install' })).toBeNull();
});
