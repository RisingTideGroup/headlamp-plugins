import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { AllowEntry, parseCidr, Purpose, PURPOSES } from './model';

interface Props {
  entries: AllowEntry[];
  /** Addresses DO currently holds, to mark rows as new. */
  saved: Set<string>;
  /** Saved addresses taken off the draft, offered back for undo. */
  removed: string[];
  onChange: (entries: AllowEntry[]) => void;
  onRestore: (cidr: string) => void;
}

function PurposeSelect({
  value,
  onChange,
  disabled,
}: {
  value: Purpose;
  onChange: (p: Purpose) => void;
  disabled?: boolean;
}) {
  return (
    <TextField
      select
      size="small"
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value as Purpose)}
      sx={{ minWidth: 220 }}
      inputProps={{ 'aria-label': 'Purpose' }}
    >
      {PURPOSES.filter(p => p.value !== 'nat-gateway' || disabled).map(p => (
        <MenuItem key={p.value} value={p.value}>
          {p.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function AllowlistTable({ entries, saved, removed, onChange, onRestore }: Props) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('workstation');
  const [error, setError] = useState<string | null>(null);

  const update = (cidr: string, patch: Partial<AllowEntry>) =>
    onChange(entries.map(e => (e.cidr === cidr ? { ...e, ...patch } : e)));

  const add = () => {
    const parsed = parseCidr(address);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (entries.some(e => e.cidr === parsed.cidr)) {
      setError(`${parsed.cidr} is already on the list.`);
      return;
    }
    onChange([...entries, { cidr: parsed.cidr, label: label.trim(), purpose, locked: false }]);
    setAddress('');
    setLabel('');
    setError(null);
  };

  return (
    <Stack spacing={2}>
      <Table size="small" aria-label="Allowed addresses">
        <TableHead>
          <TableRow>
            <TableCell>Address</TableCell>
            <TableCell>Label</TableCell>
            <TableCell>Purpose</TableCell>
            <TableCell>State</TableCell>
            <TableCell align="right">Remove</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.map(e => (
            <TableRow key={e.cidr}>
              <TableCell>
                <code>{e.cidr}</code>
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  fullWidth
                  value={e.label}
                  placeholder="e.g. Home office"
                  onChange={ev => update(e.cidr, { label: ev.target.value.slice(0, 120) })}
                  inputProps={{ 'aria-label': `Label for ${e.cidr}` }}
                />
              </TableCell>
              <TableCell>
                <PurposeSelect
                  value={e.purpose}
                  disabled={e.locked}
                  onChange={p => update(e.cidr, { purpose: p })}
                />
              </TableCell>
              <TableCell>
                {e.locked && <Chip size="small" label="Locked" color="warning" />}{' '}
                {saved.has(e.cidr) ? (
                  <Chip size="small" label="Saved" />
                ) : (
                  <Chip size="small" label="New" color="success" />
                )}
              </TableCell>
              <TableCell align="right">
                <Tooltip
                  title={
                    e.locked
                      ? 'The cluster nodes reach the API through this NAT gateway; it cannot be removed.'
                      : 'Remove'
                  }
                >
                  <span>
                    <IconButton
                      aria-label={`Remove ${e.cidr}`}
                      disabled={e.locked}
                      onClick={() => onChange(entries.filter(x => x.cidr !== e.cidr))}
                    >
                      ✕
                    </IconButton>
                  </span>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
          {entries.length === 0 && (
            <TableRow>
              <TableCell colSpan={5}>
                <Typography color="text.secondary">No addresses on the list.</Typography>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {removed.length > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2">Pending removal:</Typography>
          {removed.map(cidr => (
            <Chip
              key={cidr}
              label={`${cidr} — undo`}
              color="error"
              variant="outlined"
              onClick={() => onRestore(cidr)}
            />
          ))}
        </Stack>
      )}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="flex-start">
        <TextField
          size="small"
          label="Add address or CIDR"
          placeholder="203.0.113.7 or 203.0.113.0/24"
          value={address}
          error={!!error}
          helperText={error ?? 'Public IPv4 only. A bare address becomes /32.'}
          onChange={e => {
            setAddress(e.target.value);
            setError(null);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') add();
          }}
        />
        <TextField
          size="small"
          label="Label"
          value={label}
          onChange={e => setLabel(e.target.value.slice(0, 120))}
          onKeyDown={e => {
            if (e.key === 'Enter') add();
          }}
        />
        <PurposeSelect value={purpose} onChange={setPurpose} />
        <Button variant="outlined" onClick={add} disabled={!address.trim()}>
          Add
        </Button>
      </Stack>
    </Stack>
  );
}
