import type {
  CreateGroupBody,
  CreateGroupResponse,
  DeleteGroupResponse,
  GetGroupResponse,
  GetUserGroupResponse,
} from "@youtube-shorts-chain-blocker/api-contract";
import type { DurableObjectState } from "./cloudflare.js";
import {
  createGroupInRegistry,
  createInitialGroupRegistryState,
  deleteGroupFromRegistry,
  getGroupByIdFromRegistry,
  getGroupByUserIdFromRegistry,
  type GroupRegistryState,
} from "./groups.js";
import { jsonError, jsonSuccess } from "./http.js";

const STORAGE_KEY = "group-registry-state";

export class GroupRegistryDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/internal/groups') {
      const body = (await request.json()) as CreateGroupBody
      return this.handleCreateGroup(body)
    }

    if (request.method === 'GET' && url.pathname.startsWith('/internal/groups/')) {
      const groupId = getLastPathSegment(url.pathname)
      return this.handleGetGroup(groupId)
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/internal/groups/')) {
      const groupId = getLastPathSegment(url.pathname)
      return this.handleDeleteGroup(groupId)
    }

    if (
      request.method === 'GET' &&
      url.pathname.startsWith('/internal/users/') &&
      url.pathname.endsWith('/group')
    ) {
      const userId = getLastPathSegment(url.pathname, 1)
      return this.handleGetUserGroup(userId)
    }

    return jsonError('METHOD_NOT_ALLOWED', 'Unsupported group registry route.', {
      status: 405,
    })
  }

  private async handleCreateGroup(body: CreateGroupBody): Promise<Response> {
    const state = await this.loadState()
    const result = createGroupInRegistry(state, {
      groupId: body.groupId,
      memberIds: body.memberIds,
    })

    if (!result.ok) {
      return jsonError(mapGroupErrorCode(result.reason), result.reason, {
        status: 400,
      })
    }

    await this.persistState(result.state)

    const response: CreateGroupResponse = {
      success: true,
      data: {
        group: result.group,
      },
    }

    return jsonSuccess(response.data)
  }

  private async handleGetGroup(groupId: string): Promise<Response> {
    const state = await this.loadState()
    const group = getGroupByIdFromRegistry(state, groupId)

    if (!group) {
      return jsonError('GROUP_NOT_FOUND', 'Group was not found.', {
        status: 404,
      })
    }

    const response: GetGroupResponse = {
      success: true,
      data: {
        group,
      },
    }

    return jsonSuccess(response.data)
  }

  private async handleGetUserGroup(userId: string): Promise<Response> {
    const state = await this.loadState()
    const group = getGroupByUserIdFromRegistry(state, userId)

    if (!group) {
      return jsonError('GROUP_NOT_FOUND', 'User group was not found.', {
        status: 404,
      })
    }

    const response: GetUserGroupResponse = {
      success: true,
      data: {
        group,
      },
    }

    return jsonSuccess(response.data)
  }

  private async handleDeleteGroup(groupId: string): Promise<Response> {
    const state = await this.loadState()
    const result = deleteGroupFromRegistry(state, groupId)

    if (!result.ok) {
      return jsonError('GROUP_NOT_FOUND', 'Group was not found.', {
        status: 404,
      })
    }

    await this.persistState(result.state)

    const response: DeleteGroupResponse = {
      success: true,
      data: {
        groupId,
        deleted: true,
      },
    }

    return jsonSuccess(response.data)
  }

  private async loadState(): Promise<GroupRegistryState> {
    return (
      (await this.state.storage.get<GroupRegistryState>(STORAGE_KEY)) ??
      createInitialGroupRegistryState()
    )
  }

  private async persistState(state: GroupRegistryState): Promise<void> {
    await this.state.storage.put(STORAGE_KEY, state)
  }
}

const mapGroupErrorCode = (reason: string) => {
  if (reason === 'A user can belong to only one active group.') {
    return 'USER_ALREADY_IN_GROUP' as const
  }

  if (reason === 'Group id already exists.') {
    return 'GROUP_ALREADY_EXISTS' as const
  }

  return 'INVALID_GROUP_MEMBERS' as const
}

const getLastPathSegment = (pathname: string, trimTailSegments = 0): string => {
  const segments = pathname.split('/').filter(Boolean)
  return segments[segments.length - 1 - trimTailSegments] ?? ''
}
