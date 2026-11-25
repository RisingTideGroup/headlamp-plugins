import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { AllowEntry, ListDiff, Validation } from './model';

interface Props {
  open: boolean;
  clusterName: string;
  diff: ListDiff;
  entries: AllowEntry[];
  /** Rows as loaded from DO, to label the removals. */
  baseline: AllowEntry[];
  enabledBefore: boolean;
  enabledAfter: boolean;
  validation: Validation;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function AddressList({
  title,
  cidrs,
  entries,
  color,
}: {
  title: string;
  cidrs: string[];
  entries: AllowEntry[];
  color: string;
}) {
  if (cidrs.length === 0) return null;
  const labelOf = (cidr: string) => entries.find(e => e.cidr === cidr)?.label;
  return (
    <div>
      <Typography variant="subtitle2" sx={{ color }}>
        {title} ({cidrs.length})
      </Typography>
      <ul style={{ margin: 0 }}>
        {cidrs.map(c => (
          <li key={c}>
            <code>{c}</code> {labelOf(c) ? `— ${labelOf(c)}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewDialog(props: Props) {
  const { open, clusterName, diff, entries, enabledBefore, enabledAfter, validation, saving } =
    props;
  const [ack, setAck] = useState(false);
  const blocked = validation.errors.length > 0 || (validation.warnings.length > 0 && !ack);

  return (
    <Dialog open={open} onClose={saving ? undefined : props.onCancel} maxWidth="md" fullWidth>
      <DialogTitle>Review firewall change — {clusterName}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography>
            DigitalOcean replaces the whole list on every save. This sends{' '}
            <strong>{entries.length}</strong> address
            {entries.length === 1 ? '' : 'es'} with the firewall{' '}
            <strong>{enabledAfter ? 'enabled' : 'disabled'}</strong>
            {enabledBefore !== enabledAfter
              ? ` (was ${enabledBefore ? 'enabled' : 'disabled'})`
              : ''}
            .
          </Typography>
          <AddressList title="Adding" cidrs={diff.added} entries={entries} color="success.main" />
          <AddressList
            title="Removing"
            cidrs={diff.removed}
            entries={props.baseline}
            color="error.main"
          />
          <AddressList
            title="Keeping"
            cidrs={diff.unchanged}
            entries={entries}
            color="text.secondary"
          />
          {validation.errors.map(e => (
            <Alert key={e} severity="error">
              {e}
            </Alert>
          ))}
          {validation.warnings.map(w => (
            <Alert key={w} severity="warning">
              {w}
            </Alert>
          ))}
          {validation.errors.length === 0 && validation.warnings.length > 0 && (
            <FormControlLabel
              control={<Checkbox checked={ack} onChange={e => setAck(e.target.checked)} />}
              label="I understand the warnings above; save anyway."
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onCancel} disabled={saving}>
          Back to editing
        </Button>
        <Button
          variant="contained"
          color="primary"
          onClick={props.onConfirm}
          disabled={blocked || saving}
        >
          {saving
            ? 'Saving…'
            : `Save ${entries.length} address${entries.length === 1 ? '' : 'es'} to DigitalOcean`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
