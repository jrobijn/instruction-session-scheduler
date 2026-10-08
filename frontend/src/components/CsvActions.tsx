import { useRef, type ChangeEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import { useT } from '../i18n';
import { Alert, Button, useToast } from '../ui';

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

interface CsvActionsProps {
  filename: string;
  exportCsv: () => Promise<string>;
  importCsv: (csv: string) => Promise<ImportResult>;
  onImported: (result: ImportResult) => void;
  disabled?: boolean;
}

/** Export / Import CSV buttons for list page headers. */
export function CsvActions({ filename, exportCsv, importCsv, onImported, disabled }: CsvActionsProps) {
  const t = useT();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    try {
      const blob = new Blob([await exportCsv()], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast(err.message);
    }
  };

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      onImported(await importCsv(await file.text()));
    } catch (err: any) {
      toast(err.message);
    }
    e.target.value = '';
  };

  return (
    <>
      <Button icon={<Download />} onClick={handleExport} disabled={disabled}>{t.exportCsv}</Button>
      <Button icon={<Upload />} onClick={() => fileInputRef.current?.click()} disabled={disabled}>{t.importCsv}</Button>
      <input ref={fileInputRef} type="file" accept=".csv" onChange={handleImport} hidden />
    </>
  );
}

export function ImportResultAlert({ result, onDismiss }: { result: ImportResult; onDismiss: () => void }) {
  const t = useT();
  return (
    <Alert
      tone={result.errors.length > 0 ? 'warning' : 'success'}
      title={t.importResult(result.imported, result.skipped)}
      action={<Button variant="ghost" size="sm" onClick={onDismiss}>{t.dismiss}</Button>}
    >
      {result.errors.length > 0 && (
        <ul>
          {result.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </Alert>
  );
}
