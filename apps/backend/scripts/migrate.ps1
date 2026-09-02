# Apply migrations in order to $env:DATABASE_URL
if (-not $env:DATABASE_URL) {
  if (Test-Path .env) { Get-Content .env | ForEach-Object { if ($_ -match '^\s*DATABASE_URL\s*=\s*(.*)') { $env:DATABASE_URL = $Matches[1].Trim('"').Trim("'") } } }
}
if (-not $env:DATABASE_URL) { Write-Error "DATABASE_URL not set"; exit 1 }
Get-ChildItem app/db/migrations/*.sql | Sort-Object Name | ForEach-Object {
  Write-Host "=> $($_.Name)"
  psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f $_.FullName
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "done"
