param(
  # Период в минутах для фонового режима.
  [int]$EveryMinutes = 5
)
<#
  Автозапуск синхронизатора «Шараги» на Windows.

  Что делает: каждые $EveryMinutes минут сам забирает задания с телефона
  (дз/домашка.json) и заливает готовые решения обратно в облако.
  Ничего нажимать не нужно.

  Как запустить:
    powershell -ExecutionPolicy Bypass -File .\start-sync.ps1
  Права администратора НЕ нужны.

  Как остановить:
    .\stop-sync.ps1
#>

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host 'Node.js не найден. Поставь его с nodejs.org и запусти скрипт снова.' -ForegroundColor Red
  exit 1
}
$sync = Join-Path $repo '.github\scripts\sync.js'
$taskName = 'SharagaSync'

# --- разовый запуск: сначала синхронизируемся, чтобы убедиться, что всё живо ---
Write-Host 'Проверяю связь с облаком...' -ForegroundColor Cyan
& $node $sync auto
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Связь не удалась. Ничего не сломано — попробую позже. Проверь интернет и запусти ещё раз.' -ForegroundColor Yellow
}

# --- задача в планировщике Windows ---
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$sync`" auto"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
# По умолчанию планировщик не запускает задачи на батарее и не будит компьютер.
# Именно это и ломает связь, когда ноутбук закрыт, — поэтому всё это включено.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
try {
  Register-ScheduledTask -TaskName $taskName `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Шарага: тянет ДЗ с телефона и заливает готовые решения обратно' -ErrorAction Stop | Out-Null
} catch {
  # Так бывает, если задача уже создана другой учётной записью (например, SYSTEM):
  # её не видно и нельзя удалить без прав администратора. Лечится одним запуском
  # от имени администратора — после этого всё работает под твоей учёткой.
  Write-Host ''
  Write-Host "Не удалось пересоздать задачу: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Похоже, такая задача уже создана с правами SYSTEM.' -ForegroundColor Yellow
  Write-Host 'Закрой это окно, нажми правой кнопкой по start-sync.ps1 -> «Запуск от имени администратора».' -ForegroundColor Yellow
  exit 1
}

Write-Host ''
Write-Host "Готово. Синхронизация сама пойдёт каждые $EveryMinutes минут." -ForegroundColor Green
Write-Host 'Проверить вручную:  node .github\scripts\sync.js list'
Write-Host 'Остановить:          .\stop-sync.ps1'
Write-Host ''
Write-Host 'Пока телефон не выгрузил ДЗ кнопкой «В облако», в дз\домашка.json будет пусто.' -ForegroundColor DarkGray
