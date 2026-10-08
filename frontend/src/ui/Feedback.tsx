import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Toast } from 'radix-ui';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from './Button';
import { Dialog } from './Dialog';
import styles from './Feedback.module.css';
import { cx } from './cx';

export interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ToastTone = 'info' | 'success' | 'danger';

interface FeedbackApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  toast: (message: ReactNode, tone?: ToastTone) => void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

const toastIcons: Record<ToastTone, ReactNode> = {
  info: <Info />,
  success: <CircleCheck />,
  danger: <CircleX />,
};

/** Provides useConfirm() and useToast(); mount once inside I18nProvider. */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<{ id: number; message: ReactNode; tone: ToastTone }[]>([]);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>(resolve => setPending({ ...options, resolve })),
    [],
  );
  const toast = useCallback((message: ReactNode, tone: ToastTone = 'danger') => {
    setToasts(list => [...list, { id: Date.now() + Math.random(), message, tone }]);
  }, []);

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <FeedbackContext.Provider value={{ confirm, toast }}>
      <Toast.Provider duration={6000}>
        {children}
        {toasts.map(item => (
          <Toast.Root
            key={item.id}
            className={cx(styles.toast, styles[item.tone])}
            onOpenChange={open => { if (!open) setToasts(list => list.filter(x => x.id !== item.id)); }}
          >
            <span className={styles.icon}>{toastIcons[item.tone]}</span>
            <Toast.Description className={styles.message}>{item.message}</Toast.Description>
            <Toast.Close asChild>
              <Button variant="ghost" size="sm" icon={<X />} aria-label={t.close} />
            </Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport className={styles.viewport} />
      </Toast.Provider>
      <Dialog
        open={!!pending}
        onOpenChange={open => { if (!open) settle(false); }}
        title={pending?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button onClick={() => settle(false)}>{t.cancel}</Button>
            <Button variant={pending?.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
              {pending?.confirmLabel ?? t.confirm}
            </Button>
          </>
        }
      >
        {pending?.message}
      </Dialog>
    </FeedbackContext.Provider>
  );
}

function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('FeedbackProvider is missing');
  return ctx;
}

/** Promise-based replacement for window.confirm(). */
export function useConfirm() {
  return useFeedback().confirm;
}

/** Transient message; defaults to the danger tone (replacement for alert(err.message)). */
export function useToast() {
  return useFeedback().toast;
}
