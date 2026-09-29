param()
<#
  Останавливает фоновую синхронизацию «Шараги».
  Запускать так же:  .\stop-sync.ps1
#>
$taskName = 'SharagaSync'
$found = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($found) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host 'Фоновая синхронизация остановлена и удалена.' -ForegroundColor Green
} else {
  # Задачи нет в твоей учётке — возможно, она создана от SYSTEM и видна только админу.
  Write-Host 'Под твоей учёткой такой задачи нет.' -ForegroundColor Yellow
  Write-Host 'Если она всё же работает — запусти это окно от имени администратора.' -ForegroundColor Yellow
}
