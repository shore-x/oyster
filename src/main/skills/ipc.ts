import {
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { skillChannels } from '../../shared/channels'
import type { ManagedSkillBindingInput } from '../../shared/skills'
import type { ManagedSkillService } from './managed-skill-service'
import type { SkillDiscoveryService } from './skill-discovery-service'

export function registerSkillIpc(
  service: SkillDiscoveryService,
  managedService: ManagedSkillService,
  getMainWindow: () => BrowserWindow | undefined
): void {
  const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
    const window = getMainWindow()
    if (
      !window
      || window.isDestroyed()
      || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('拒绝来自非主窗口的 Skill 请求')
    }
  }

  ipcMain.handle(skillChannels.getDiscoveryStateView, (event) => {
    assertTrustedSender(event)
    return service.getSnapshot()
  })
  ipcMain.handle(skillChannels.discover, (event) => {
    assertTrustedSender(event)
    return service.discover()
  })
  ipcMain.handle(skillChannels.readDiscoveredDocument, (event, skillId: string) => {
    assertTrustedSender(event)
    return service.readDocument(skillId)
  })
  ipcMain.handle(skillChannels.openDiscoveredFolder, async (event, skillId: string) => {
    assertTrustedSender(event)
    const folderPath = await service.getSkillFolderPath(skillId)
    const message = await shell.openPath(folderPath)
    if (message) throw new Error(`无法打开 Skill 文件夹：${message}`)
  })
  ipcMain.handle(skillChannels.getManagedSnapshot, (event) => {
    assertTrustedSender(event)
    return managedService.getSnapshot()
  })
  ipcMain.handle(
    skillChannels.readManagedDocument,
    (event, artifactDirectoryName: string) => {
      assertTrustedSender(event)
      return managedService.readDocument(artifactDirectoryName)
    }
  )
  ipcMain.handle(
    skillChannels.openManagedFolder,
    async (event, artifactDirectoryName: string) => {
      assertTrustedSender(event)
      const folderPath = await managedService.getFolderPath(artifactDirectoryName)
      const message = await shell.openPath(folderPath)
      if (message) throw new Error(`无法打开 Skill Artifact 文件夹：${message}`)
    }
  )
  ipcMain.handle(
    skillChannels.bindManagedSkill,
    (event, input: ManagedSkillBindingInput) => {
      assertTrustedSender(event)
      return managedService.bind(input)
    }
  )
  ipcMain.handle(
    skillChannels.unbindManagedSkill,
    (event, input: ManagedSkillBindingInput) => {
      assertTrustedSender(event)
      return managedService.unbind(input)
    }
  )
}
