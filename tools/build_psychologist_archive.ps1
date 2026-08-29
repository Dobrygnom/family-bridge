param(
    [string]$RawDirectory = (Join-Path $PSScriptRoot '..\psychologist-memory\raw'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\psychologist-memory')
)

$ErrorActionPreference = 'Stop'
$rawPath = [System.IO.Path]::GetFullPath($RawDirectory)
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$files = @(Get-ChildItem -LiteralPath $rawPath -Filter 'page-*.json' | Sort-Object Name)

if ($files.Count -eq 0) {
    throw "No archive pages found in $rawPath"
}

$allTurns = [System.Collections.Generic.List[object]]::new()
foreach ($file in $files) {
    $page = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
    foreach ($turn in @($page.turns)) {
        $allTurns.Add($turn)
    }
}

$orderedTurns = @($allTurns | Sort-Object { [double]$_.startedAt })
$records = [System.Collections.Generic.List[string]]::new()
$userMessages = 0
$assistantMessages = 0

foreach ($turn in $orderedTurns) {
    foreach ($item in @($turn.items)) {
        $role = switch ($item.type) {
            'userMessage' { $userMessages++; 'user' }
            'agentMessage' { $assistantMessages++; 'assistant' }
            default { 'other' }
        }

        $record = [ordered]@{
            turn_id = $turn.id
            item_id = $item.id
            role = $role
            timestamp = [double]$turn.startedAt
            payload = $item
        }
        $records.Add(($record | ConvertTo-Json -Compress -Depth 100))
    }
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$transcriptPath = Join-Path $outputPath 'transcript.jsonl'
[System.IO.File]::WriteAllLines($transcriptPath, $records, $utf8)

$manifest = [ordered]@{
    source = [ordered]@{
        product = 'ChatGPT'
        project = 'Живи'
        conversation_title = 'Карманный психолог'
        conversation_id = '6a68ce87-e968-83eb-a4af-7624e3963da8'
    }
    generated_at_utc = [DateTime]::UtcNow.ToString('o')
    order = 'oldest_first'
    pages = $files.Count
    turns = $orderedTurns.Count
    user_messages = $userMessages
    assistant_messages = $assistantMessages
    earliest_timestamp = [double]$orderedTurns[0].startedAt
    latest_timestamp = [double]$orderedTurns[-1].startedAt
    raw_directory = 'raw'
    transcript_file = 'transcript.jsonl'
}
$manifestPath = Join-Path $outputPath 'manifest.json'
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 10),
    $utf8
)

Write-Output ($manifest | ConvertTo-Json -Compress -Depth 10)
