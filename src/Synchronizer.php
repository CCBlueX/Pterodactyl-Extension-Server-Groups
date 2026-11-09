<?php

declare(strict_types=1);

namespace ServerGroups;

use Illuminate\Support\Facades\Cache;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\Subuser;
use Pterodactyl\Models\User;
use ServerGroups\Models\Grant;
use ServerGroups\Models\Group;
use ServerGroups\Models\Member;
use ServerGroups\Panel\Panel;
use ServerGroups\Support\Access;
use Throwable;

/**
 * Turns group memberships into real subusers and removes the ones that are no longer needed.
 */
final readonly class Synchronizer
{
    public function __construct(private Panel $panel) {}

    /** @return array{created: int, updated: int, removed: int, skipped: int, failed: int} */
    public function sync(): array
    {
        return Cache::lock('ext:server-groups:sync', 300)->block(30, function (): array {
            $stats = ['created' => 0, 'updated' => 0, 'removed' => 0, 'skipped' => 0, 'failed' => 0];
            $groups = Group::query()->with(['servers' => static fn ($query) => $query->without('allocation')->select(['servers.id', 'servers.owner_id']), 'members'])->get();

            $desired = Access::desired(
                $groups->map(static fn (Group $group): array => [
                    'servers' => $group->servers->pluck('id')->all(),
                    'members' => $group->members->map(static fn (Member $member): array => ['user' => $member->user_id, 'permissions' => $member->permissions])->all(),
                ])->all(),
                $groups->flatMap(static fn (Group $group) => $group->servers)->pluck('owner_id', 'id')->all(),
            );

            $grants = Grant::query()->get()->toBase()->keyBy(static fn (Grant $grant): string => "{$grant->server_id}:{$grant->user_id}");

            foreach ($desired as $key => $permissions) {
                try {
                    $stats[$this->apply($key, $permissions, $grants->get($key))]++;
                } catch (Throwable $exception) {
                    report($exception);
                    $stats['failed']++;
                }
            }

            foreach ($grants->except(array_keys($desired)) as $grant) {
                try {
                    $this->revoke($grant);
                    $stats['removed']++;
                } catch (Throwable $exception) {
                    report($exception);
                    $stats['failed']++;
                }
            }

            return $stats;
        });
    }

    /** @param list<string> $permissions */
    private function apply(string $key, array $permissions, ?Grant $grant): string
    {
        [$serverId, $userId] = array_map(intval(...), explode(':', $key));
        $server = Server::query()->findOrFail($serverId);
        $subuser = Subuser::query()->where('server_id', $serverId)->where('user_id', $userId)->first();

        if ($grant === null && $subuser !== null) {
            return 'skipped';
        }

        if ($grant !== null && $subuser !== null) {
            $current = $subuser->permissions;
            sort($current);

            if ($current === $permissions) {
                return 'skipped';
            }

            $this->panel->update($server, $subuser, $permissions);
            Grant::query()->where('server_id', $serverId)->where('user_id', $userId)->update(['permissions' => json_encode($permissions)]);

            return 'updated';
        }

        $subuser = $this->panel->add($server, User::query()->findOrFail($userId), $permissions);
        Grant::query()->where('server_id', $serverId)->where('user_id', $userId)->delete();
        Grant::query()->create(['server_id' => $serverId, 'user_id' => $userId, 'subuser_id' => $subuser->id, 'permissions' => $permissions]);

        return 'created';
    }

    private function revoke(Grant $grant): void
    {
        $subuser = Subuser::query()->with('user')->find($grant->subuser_id);

        if ($subuser !== null) {
            $this->panel->remove(Server::query()->findOrFail($grant->server_id), $subuser);
        }

        Grant::query()->where('server_id', $grant->server_id)->where('user_id', $grant->user_id)->delete();
    }
}
