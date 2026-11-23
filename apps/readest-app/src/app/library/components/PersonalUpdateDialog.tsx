import { useCallback, useEffect, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';

interface UpdateInfo {
  currentVersion: string;
  release?: { versionCode: number; versionName: string; size: number };
}

type Status =
  | 'checking'
  | 'checkFailed'
  | 'ready'
  | 'downloading'
  | 'permission'
  | 'installer'
  | 'installFailed'
  | 'invalidPackage';

export default function PersonalUpdateDialog({ onClose }: { onClose: () => void }) {
  const _ = useTranslation();
  const [status, setStatus] = useState<Status>('checking');
  const [info, setInfo] = useState<UpdateInfo>();
  const [percent, setPercent] = useState(0);
  const update = info?.release;
  const downloading = status === 'downloading';

  const check = useCallback(async () => {
    setStatus('checking');
    setInfo(undefined);
    try {
      setInfo(await invoke<UpdateInfo>('check_personal_update'));
      setStatus('ready');
    } catch {
      setStatus('checkFailed');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const install = async () => {
    if (!update || downloading) return;
    setPercent(0);
    setStatus('downloading');
    const onProgress = new Channel<number>();
    onProgress.onmessage = setPercent;
    try {
      const outcome = await invoke<'permission' | 'installer'>('install_personal_update', {
        versionCode: update.versionCode,
        onProgress,
      });
      setStatus(outcome);
    } catch (error) {
      setStatus(
        String(error).includes('invalid-update-package') ? 'invalidPackage' : 'installFailed',
      );
    }
  };

  return (
    <Dialog
      isOpen
      title={_('App update')}
      onClose={() => {
        if (!downloading) onClose();
      }}
      dismissible={!downloading}
      boxClassName='sm:max-w-sm! sm:h-auto'
    >
      <div className='flex flex-col gap-3 pb-4'>
        {info && (
          <p className='text-base-content/70 text-sm'>
            {_('Version {{version}}', { version: info.currentVersion })}
          </p>
        )}
        {update && (
          <div className='eink-bordered border-base-300 flex items-center justify-between gap-3 rounded-lg border px-3 py-2'>
            <span className='font-medium'>{update.versionName}</span>
            <span className='text-base-content/70 shrink-0 text-sm'>
              {Math.ceil(update.size / 1024 / 1024)} MB
            </span>
          </div>
        )}
        <div role='status' className='text-base-content/80 text-sm'>
          {status === 'checking' && _('Checking for updates...')}
          {status === 'checkFailed' && _('Error checking for updates')}
          {status === 'ready' && !update && _('Already the latest version')}
          {status === 'permission' &&
            _('Allow installs from this app in Android settings, then return to continue.')}
          {status === 'installer' && _('Confirm the update in the Android installer.')}
          {status === 'installFailed' &&
            _('Could not download the update or open the Android installer. Try again.')}
          {status === 'invalidPackage' && _('The update package could not be verified.')}
          {downloading && (
            <>
              <label htmlFor='personal-update-progress'>
                {_('Downloading update · {{percent}}%', { percent })}
              </label>
              <progress
                id='personal-update-progress'
                className='progress mt-2 w-full'
                max={100}
                value={percent}
              />
            </>
          )}
        </div>
        {update && !downloading && status !== 'invalidPackage' && (
          <button type='button' className='btn btn-contrast' onClick={() => void install()}>
            {status === 'permission' || status === 'installer'
              ? _('Continue installation')
              : _('Download and install')}
          </button>
        )}
        {(status === 'checkFailed' || status === 'invalidPackage') && (
          <button type='button' className='btn btn-contrast' onClick={() => void check()}>
            {_('Check Update')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
