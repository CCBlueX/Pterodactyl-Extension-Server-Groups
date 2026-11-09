<?php

declare(strict_types=1);

namespace ServerGroups\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\User;
use ServerGroups\Models\Group;
use ServerGroups\Models\Member;
use ServerGroups\Synchronizer;

final class AdminController
{
    public function __construct(private readonly Synchronizer $synchronizer) {}

    public function index(): JsonResponse
    {
        return new JsonResponse([
            'groups' => Group::query()->with(['servers', 'members.user:id,username,email'])->orderBy('name')->get()->map(self::present(...)),
            'servers' => Server::query()->orderBy('name')->toBase()->get(['id', 'name', 'uuidShort'])
                ->map(static fn (object $server): array => ['id' => (int) $server->id, 'name' => (string) $server->name, 'identifier' => (string) $server->uuidShort]),
        ]);
    }

    public function users(Request $request): JsonResponse
    {
        $query = (string) $request->query('query', '');

        return new JsonResponse(['users' => User::query()
            ->when($query !== '', static fn ($builder) => $builder->where(static fn ($inner) => $inner->where('username', 'like', "%{$query}%")->orWhere('email', 'like', "%{$query}%")))
            ->orderBy('username')
            ->limit(25)
            ->get(['id', 'username', 'email'])]);
    }

    public function store(Request $request): JsonResponse
    {
        return $this->save(new Group(), $request);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        return $this->save(Group::query()->findOrFail($id), $request);
    }

    public function destroy(int $id): JsonResponse
    {
        Group::query()->findOrFail($id)->delete();

        return new JsonResponse(['sync' => $this->synchronizer->sync()] + $this->index()->getData(true));
    }

    public function sync(): JsonResponse
    {
        return new JsonResponse(['sync' => $this->synchronizer->sync()] + $this->index()->getData(true));
    }

    /** Groups of every server, for the column on the admin server list. */
    public function servers(): JsonResponse
    {
        $memberships = [];

        $rows = DB::table('ext_server_groups_servers')
            ->join('ext_server_groups_groups', 'ext_server_groups_groups.id', '=', 'ext_server_groups_servers.group_id')
            ->orderBy('ext_server_groups_groups.name')
            ->get(['ext_server_groups_servers.server_id', 'ext_server_groups_groups.id', 'ext_server_groups_groups.name', 'ext_server_groups_groups.color']);

        foreach ($rows as $row) {
            $memberships[(int) $row->server_id][] = ['id' => (int) $row->id, 'name' => (string) $row->name, 'color' => (string) $row->color];
        }

        return new JsonResponse(['servers' => (object) $memberships]);
    }

    /** @return array<string, mixed> */
    private static function present(Group $group): array
    {
        return [
            'id' => $group->id,
            'name' => $group->name,
            'color' => $group->color,
            'servers' => $group->servers->map(static fn (Server $server): array => ['id' => $server->id, 'name' => $server->name])->values(),
            'members' => $group->members->map(static fn (Member $member): array => [
                'user' => $member->user_id,
                'username' => $member->user->username,
                'email' => $member->user->email,
                'permissions' => $member->permissions,
            ])->values(),
        ];
    }

    private function save(Group $group, Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:191'],
            'color' => ['required', 'regex:/^#[0-9a-f]{6}$/i'],
            'servers' => ['present', 'array', 'max:1000'],
            'servers.*' => ['integer', 'distinct', 'exists:servers,id'],
            'members' => ['present', 'array', 'max:200'],
            'members.*.user' => ['required', 'integer', 'distinct', 'exists:users,id'],
            'members.*.permissions' => ['required', 'array', 'min:1', 'max:100'],
            'members.*.permissions.*' => ['string', 'max:100', 'regex:/^[a-z0-9_.-]+$/'],
        ]);

        DB::transaction(static function () use ($group, $data): void {
            $group->fill(['name' => $data['name'], 'color' => mb_strtolower($data['color'])])->save();
            $group->servers()->sync($data['servers']);
            Member::query()->where('group_id', $group->id)->delete();

            foreach ($data['members'] as $member) {
                Member::query()->create(['group_id' => $group->id, 'user_id' => $member['user'], 'permissions' => array_values(array_unique($member['permissions']))]);
            }
        });

        return new JsonResponse(['sync' => $this->synchronizer->sync()] + $this->index()->getData(true));
    }
}
