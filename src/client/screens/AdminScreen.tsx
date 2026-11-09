import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Input, Label, NamedIcon, PageContentBlock, Select, ServerError, Spinner, TitledGreyBox, httpErrorToHuman, toast } from '@pterodactyl/sdk';
import { deleteGroup, getAdmin, getPermissionKeys, keys, saveGroup, searchUsers, syncGroups, type AdminData, type AdminGroup, type GroupInput } from '../api';
import GroupTitle from '../components/GroupTitle';
import { PRESETS, presetLabel, presetOf } from '../presets';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Groups store #rrggbb, so the theme's primary colour (any CSS colour syntax) is read back as a pixel.
const themeColor = () => {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    const context = value ? document.createElement('canvas').getContext('2d', { willReadFrequently: true }) : null;
    if (!context) return '#3b82f6';
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
};

interface DraftMember {
    user: number;
    label: string;
    permissions: string[];
    custom?: boolean;
}

interface Draft extends Omit<GroupInput, 'members'> {
    members: DraftMember[];
}

export default function AdminScreen() {
    const queryClient = useQueryClient();
    const data = useQuery({ queryKey: keys.admin, queryFn: getAdmin });
    const permissions = useQuery({ queryKey: keys.permissions, queryFn: getPermissionKeys, staleTime: Infinity });
    const all = (permissions.data ?? []).map((item) => item.key);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [removing, setRemoving] = useState<AdminGroup | null>(null);

    const done = (result: AdminData) => {
        queryClient.setQueryData(keys.admin, result);
        queryClient.invalidateQueries({ queryKey: keys.adminServers });

        if (result.sync) {
            const { created, updated, removed, failed } = result.sync;
            if (failed) {
                toast.error(`${failed} subusers could not be synced. Check the panel log.`);
            } else {
                toast.success(created + updated + removed === 0 ? 'Access is up to date.' : `Access synced: ${created} added, ${updated} changed, ${removed} removed.`);
            }
        }
    };
    const onError = (error: unknown) => toast.error(httpErrorToHuman(error));

    const saving = useMutation({
        mutationFn: () => saveGroup({ ...draft!, members: draft!.members.map(({ user, permissions }) => ({ user, permissions })) }),
        onSuccess: (result) => (done(result), setDraft(null)),
        onError,
    });
    const removal = useMutation({ mutationFn: (id: number) => deleteGroup(id), onSuccess: (result) => (done(result), setRemoving(null)), onError });
    const syncing = useMutation({ mutationFn: syncGroups, onSuccess: done, onError });

    return (
        <PageContentBlock title='Server Groups'>
            <header className='sgr:mb-6 sgr:flex sgr:flex-col sgr:gap-3 sgr:sm:flex-row sgr:sm:items-center sgr:sm:justify-between'>
                <div className='sgr:min-w-0'>
                    <h1 className='sgr:font-header sgr:text-2xl sgr:font-semibold sgr:text-foreground'>Server Groups</h1>
                    <p className='sgr:mt-1 sgr:text-sm sgr:leading-relaxed sgr:text-foreground/70'>
                        Members of a group become subusers of all its servers. Subusers added by hand are never changed.
                    </p>
                </div>
                <div className='sgr:flex sgr:shrink-0 sgr:gap-2'>
                    <Button.Text isLoading={syncing.isPending} onClick={() => syncing.mutate()}>
                        Sync now
                    </Button.Text>
                    <Button onClick={() => setDraft({ name: '', color: themeColor(), servers: [], members: [] })}>New group</Button>
                </div>
            </header>

            {!data.data ? (
                data.isError ? (
                    <ServerError title='Could not load server groups' message={httpErrorToHuman(data.error)} onRetry={() => data.refetch()} />
                ) : (
                    <Spinner centered size={Spinner.Size.LARGE} />
                )
            ) : data.data.groups.length === 0 ? (
                <Empty className='sgr:rounded-sm sgr:border sgr:border-border sgr:bg-card'>
                    <EmptyHeader>
                        <EmptyMedia variant='icon'>
                            <NamedIcon name='layers' />
                        </EmptyMedia>
                        <EmptyTitle>No groups yet</EmptyTitle>
                        <EmptyDescription>Group servers and members to give everyone in the group subuser access at once.</EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                        <Button onClick={() => setDraft({ name: '', color: themeColor(), servers: [], members: [] })}>New group</Button>
                    </EmptyContent>
                </Empty>
            ) : (
                <div className='sgr:grid sgr:gap-4 sgr:md:grid-cols-2'>
                    {data.data.groups.map((group) => (
                        <TitledGreyBox key={group.id} title={<GroupTitle name={group.name} color={group.color} />}>
                            <p className='sgr:text-xs sgr:uppercase sgr:text-muted-foreground'>{plural(group.servers.length, 'server')}</p>
                            <p className='sgr:mb-3 sgr:truncate sgr:text-sm sgr:text-foreground'>{group.servers.map((server) => server.name).join(', ') || 'None'}</p>
                            <p className='sgr:text-xs sgr:uppercase sgr:text-muted-foreground'>{plural(group.members.length, 'member')}</p>
                            <ul className='sgr:mb-3 sgr:text-sm'>
                                {group.members.map((member) => (
                                    <li key={member.user} className='sgr:flex sgr:justify-between sgr:gap-2'>
                                        <span className='sgr:truncate sgr:text-foreground'>{member.username}</span>
                                        <span className='sgr:shrink-0 sgr:text-muted-foreground'>{presetLabel(member.permissions, all)}</span>
                                    </li>
                                ))}
                            </ul>
                            <div className='sgr:flex sgr:justify-end sgr:gap-2'>
                                <Button.Text
                                    size='small'
                                    onClick={() =>
                                        setDraft({
                                            id: group.id,
                                            name: group.name,
                                            color: group.color,
                                            servers: group.servers.map((server) => server.id),
                                            members: group.members.map((member) => ({ user: member.user, label: `${member.username} (${member.email})`, permissions: member.permissions })),
                                        })
                                    }
                                >
                                    Edit
                                </Button.Text>
                                <Button.Danger size='small' onClick={() => setRemoving(group)}>
                                    Delete
                                </Button.Danger>
                            </div>
                        </TitledGreyBox>
                    ))}
                </div>
            )}

            {draft && data.data && <GroupDialog draft={draft} servers={data.data.servers} all={all} pending={saving.isPending} onChange={setDraft} onSave={() => saving.mutate()} />}

            <Dialog.Confirm
                open={removing !== null}
                onClose={() => setRemoving(null)}
                title={`Delete ${removing?.name}?`}
                confirm='Delete'
                pending={removal.isPending}
                onConfirmed={() => removing && removal.mutate(removing.id)}
            >
                Members lose the access this group gave them.
            </Dialog.Confirm>
        </PageContentBlock>
    );
}

interface DialogProps {
    draft: Draft;
    servers: AdminData['servers'];
    all: string[];
    pending: boolean;
    onChange: (draft: Draft | null) => void;
    onSave: () => void;
}

function GroupDialog({ draft, servers, all, pending, onChange, onSave }: DialogProps) {
    const [query, setQuery] = useState('');
    const users = useQuery({ queryKey: keys.users(query), queryFn: () => searchUsers(query) });
    const valid = draft.name.trim() !== '' && draft.members.every((member) => member.permissions.length > 0);

    const setMember = (user: number, changes: Partial<DraftMember>) =>
        onChange({ ...draft, members: draft.members.map((member) => (member.user === user ? { ...member, ...changes } : member)) });

    return (
        <Dialog open onClose={() => onChange(null)} title={draft.id ? 'Edit group' : 'New group'} preventExternalClose={pending}>
            <div className='sgr:grid sgr:gap-4'>
                <div className='sgr:grid sgr:grid-cols-[minmax(0,1fr)_5rem] sgr:gap-3'>
                    <div>
                        <Label htmlFor='sgr-name'>Name</Label>
                        <Input id='sgr-name' autoFocus value={draft.name} onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })} />
                    </div>
                    <div>
                        <Label htmlFor='sgr-color'>Colour</Label>
                        <Input id='sgr-color' type='color' className='sgr:h-10 sgr:p-1' value={draft.color} onChange={(event) => onChange({ ...draft, color: event.currentTarget.value })} />
                    </div>
                </div>
                <div>
                    <Label htmlFor='sgr-servers'>Servers</Label>
                    <Select
                        id='sgr-servers'
                        multiple
                        placeholder='Choose servers'
                        value={draft.servers}
                        onChange={(value) => onChange({ ...draft, servers: value.map(Number) })}
                        options={servers.map((server) => ({ value: server.id, label: `${server.name} (${server.identifier})` }))}
                    />
                    <p className='sgr:mt-1 sgr:text-xs sgr:text-muted-foreground'>
                        {servers
                            .filter((server) => draft.servers.includes(server.id))
                            .map((server) => server.name)
                            .join(', ') || 'No servers yet.'}
                    </p>
                </div>
                <div>
                    <Label htmlFor='sgr-add-member'>Members</Label>
                    <Select
                        id='sgr-add-member'
                        placeholder='Add a user'
                        searchPlaceholder='Search by name or email'
                        value={null}
                        onSearchChange={setQuery}
                        onChange={(value) => {
                            const user = users.data?.find((item) => item.id === Number(value));

                            if (user && !draft.members.some((member) => member.user === user.id)) {
                                onChange({ ...draft, members: [...draft.members, { user: user.id, label: `${user.username} (${user.email})`, permissions: PRESETS[1].expand(all) }] });
                            }
                        }}
                        options={(users.data ?? []).map((user) => ({ value: user.id, label: `${user.username} (${user.email})` }))}
                    />
                    <ul className='sgr:mt-3 sgr:grid sgr:gap-3'>
                        {draft.members.map((member) => (
                            <li key={member.user} className='sgr:rounded-sm sgr:border sgr:border-border sgr:p-3'>
                                <div className='sgr:mb-2 sgr:flex sgr:items-center sgr:justify-between sgr:gap-2'>
                                    <span className='sgr:truncate sgr:text-sm sgr:text-foreground'>{member.label}</span>
                                    <Button.Text size='xsmall' onClick={() => onChange({ ...draft, members: draft.members.filter((item) => item.user !== member.user) })}>
                                        Remove
                                    </Button.Text>
                                </div>
                                <Select
                                    aria-label='Access'
                                    value={member.custom ? 'custom' : presetOf(member.permissions, all)}
                                    onChange={(value) => {
                                        const preset = PRESETS.find((item) => item.id === value);

                                        setMember(member.user, preset ? { permissions: preset.expand(all), custom: false } : { custom: true });
                                    }}
                                    options={[...PRESETS.map((preset) => ({ value: preset.id, label: preset.label })), { value: 'custom', label: 'Custom' }]}
                                />
                                {(member.custom || presetOf(member.permissions, all) === 'custom') && (
                                    <div className='sgr:mt-2'>
                                        <Select
                                            aria-label='Permissions'
                                            multiple
                                            value={member.permissions}
                                            onChange={(value) => setMember(member.user, { permissions: value.map(String) })}
                                            options={all.map((key) => ({ value: key, label: key }))}
                                        />
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
            <Dialog.Footer>
                <Button.Text className='sgr:w-full sgr:sm:w-auto' disabled={pending} onClick={() => onChange(null)}>
                    Cancel
                </Button.Text>
                <Button className='sgr:w-full sgr:sm:w-auto' disabled={!valid} isLoading={pending} onClick={onSave}>
                    Save and sync
                </Button>
            </Dialog.Footer>
        </Dialog>
    );
}
